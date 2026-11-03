import Foundation
import Security
import Darwin

// A single private application record; no arbitrary Keychain queries or access grants.
// Isolated tests pass a private temporary Keychain; production uses the user's Keychain.
struct Input: Decodable { let operation: String; let value: String?; let password: String?; let expected: String? }
func output(_ value: [String: Any]) { let data = try! JSONSerialization.data(withJSONObject: value); FileHandle.standardOutput.write(data) }
let bytes = FileHandle.standardInput.readDataToEndOfFile()
guard bytes.count <= 262144, let input = try? JSONDecoder().decode(Input.self, from: bytes) else { output(["error":"invalid input"]); exit(2) }
#if PAIRING_ISOLATED_QA
guard CommandLine.arguments.count == 3 else { output(["error":"isolated QA only"]); exit(2) }
#else
guard CommandLine.arguments.count == 1 else { output(["error":"production helper does not accept arguments"]); exit(2) }
#endif
guard CommandLine.arguments.count == 1 || (CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--isolated-keychain") else { output(["error":"invalid arguments"]); exit(2) }
// Production storage is available only to the signed FreeLM parent, with the
// same signing team as this helper. Copying/running the helper is not an export API.
#if !PAIRING_ISOLATED_QA
if CommandLine.arguments.count == 1 {
    var ownCode: SecCode?
    var parentCode: SecCode?
    let flags = SecCSFlags(rawValue: kSecCSStrictValidate)
    guard SecCodeCopySelf([], &ownCode) == errSecSuccess,
          SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: getppid()] as CFDictionary, [], &parentCode) == errSecSuccess,
          let ownCode, let parentCode,
          SecCodeCheckValidity(ownCode, flags, nil) == errSecSuccess,
          SecCodeCheckValidity(parentCode, flags, nil) == errSecSuccess
    else { output(["error":"signed FreeLM caller required"]); exit(1) }
    var ownStatic: SecStaticCode?
    var parentStatic: SecStaticCode?
    guard SecCodeCopyStaticCode(ownCode, [], &ownStatic) == errSecSuccess,
          SecCodeCopyStaticCode(parentCode, [], &parentStatic) == errSecSuccess,
          let ownStatic, let parentStatic else { output(["error":"signed FreeLM caller required"]); exit(1) }
    var ownInfo: CFDictionary?
    var parentInfo: CFDictionary?
    guard SecCodeCopySigningInformation(ownStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &ownInfo) == errSecSuccess,
          SecCodeCopySigningInformation(parentStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &parentInfo) == errSecSuccess,
          let own = ownInfo as? [String: Any], let parent = parentInfo as? [String: Any],
          let team = own[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty,
          parent[kSecCodeInfoTeamIdentifier as String] as? String == team,
          parent[kSecCodeInfoIdentifier as String] as? String == "app.freelm.desktop"
    else { output(["error":"signed FreeLM caller required"]); exit(1) }
}
#endif
var keychain: SecKeychain?
#if PAIRING_ISOLATED_QA
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--isolated-keychain" {
    let path = CommandLine.arguments[2]
    let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
    let resolved = directory.resolvingSymlinksInPath()
    let roots = [URL(fileURLWithPath: NSTemporaryDirectory()), URL(fileURLWithPath: "/tmp")].map { $0.resolvingSymlinksInPath().path }
    guard URL(fileURLWithPath: path).lastPathComponent == "vault.keychain",
          directory.lastPathComponent.hasPrefix("freelm-enrollment-"),
          !path.contains(".."), !path.contains("login.keychain"),
          roots.contains(resolved.deletingLastPathComponent().path),
          resolved.lastPathComponent == directory.lastPathComponent,
          !FileManager.default.fileExists(atPath: path) || URL(fileURLWithPath: path).resolvingSymlinksInPath().path == resolved.appendingPathComponent("vault.keychain").path
    else { output(["error":"invalid isolated path"]); exit(2) }
    let status: OSStatus
    if input.operation == "initialize-test-keychain", let password = input.password {
        status = path.withCString { filename in password.withCString { secret in SecKeychainCreate(filename, UInt32(password.utf8.count), secret, false, nil, &keychain) } }
    } else { status = SecKeychainOpen(path, &keychain) }
    guard status == errSecSuccess else { output(["error":"secure storage unavailable", "status":status]); exit(1) }
    if input.operation == "initialize-test-keychain" { output(["ok":true]); exit(0) }
}
#endif
#if PAIRING_ISOLATED_QA
let service = "dev.freelm.local-pairing.isolated-qa.v1"
#else
let service = "dev.freelm.local-pairing.v1"
#endif
var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "issuer-and-authorization"]
if let keychain {
    if input.operation == "create" { query[kSecUseKeychain as String] = keychain }
    else { query[kSecMatchSearchList as String] = [keychain] }
}
// Serialize read/compare/update across helper processes. The lock contains no secrets.
let lockDirectory = keychain != nil ? URL(fileURLWithPath: CommandLine.arguments[2]).deletingLastPathComponent() : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/FreeLM/Pairing")
do { try FileManager.default.createDirectory(at: lockDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) } catch { output(["error":"lock unavailable"]); exit(1) }
let descriptor = open(lockDirectory.appendingPathComponent("vault.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
guard descriptor >= 0, flock(descriptor, LOCK_EX) == 0 else { output(["error":"lock unavailable"]); exit(1) }
defer { flock(descriptor, LOCK_UN); close(descriptor) }
query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
switch input.operation {
case "read":
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { output(["missing":true]) }
    else if status == errSecSuccess, let data = result as? Data, let value = String(data:data,encoding:.utf8) { output(["value":value]) }
    else { output(["error":"secure storage unavailable", "status":status]); exit(1) }
case "create", "replace":
    guard let value = input.value, value.utf8.count <= 200000 else { output(["error":"invalid record"]); exit(2) }
    let data=Data(value.utf8)
    let status: OSStatus
    if input.operation == "create" {
        query[kSecValueData as String]=data
        status=SecItemAdd(query as CFDictionary,nil)
    } else {
        var readQuery = query
        readQuery[kSecReturnData as String] = true
        var current: CFTypeRef?
        guard SecItemCopyMatching(readQuery as CFDictionary, &current) == errSecSuccess,
              let currentData = current as? Data, let expected = input.expected,
              currentData == Data(expected.utf8) else { output(["error":"record changed or unavailable"]); exit(1) }
        status=SecItemUpdate(query as CFDictionary,[kSecValueData as String:data] as CFDictionary)
    }
    guard status == errSecSuccess else { output(["error":"secure storage write failed", "status":status]); exit(1) }
    output(["ok":true])
default: output(["error":"unsupported operation"]); exit(2)
}

import Foundation
import Security

// Disposable compatibility client. Never imports into a system/user Keychain.
final class TrustDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
 let root: SecCertificate
 let identity: SecIdentity?
 init(rootPath: String, identityPath: String) throws {
  root = SecCertificateCreateWithData(nil, try Data(contentsOf: URL(fileURLWithPath: rootPath)) as CFData)!
  if identityPath == "none" { identity = nil }
  else {
   var imported: CFArray?
   let options = [kSecImportExportPassphrase as String: "synthetic-only", kSecImportToMemoryOnly as String: true] as CFDictionary
   let result = SecPKCS12Import(try Data(contentsOf: URL(fileURLWithPath: identityPath)) as CFData, options, &imported)
   guard result == errSecSuccess, let item = (imported as? [[String: Any]])?.first else { throw NSError(domain: "PKCS12", code: Int(result)) }
   identity = (item[kSecImportItemIdentity as String] as! SecIdentity)
  }
 }
 func sessionChallenge(_ challenge: URLAuthenticationChallenge, _ done: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
  switch challenge.protectionSpace.authenticationMethod {
  case NSURLAuthenticationMethodServerTrust:
   guard let trust = challenge.protectionSpace.serverTrust,
    SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, challenge.protectionSpace.host as CFString)) == errSecSuccess,
    SecTrustSetAnchorCertificates(trust, [root] as CFArray) == errSecSuccess,
    SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
    SecTrustEvaluateWithError(trust, nil) else { done(.cancelAuthenticationChallenge, nil); return }
   done(.useCredential, URLCredential(trust: trust))
  case NSURLAuthenticationMethodClientCertificate:
   guard let identity else { done(.cancelAuthenticationChallenge, nil); return }
   done(.useCredential, URLCredential(identity: identity, certificates: nil, persistence: .none))
  default: done(.cancelAuthenticationChallenge, nil)
  }
 }
 func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) { sessionChallenge(challenge, completionHandler) }
 func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) { sessionChallenge(challenge, completionHandler) }
 func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@main struct Client {
 static func main() async {
  do {
   let args = CommandLine.arguments
   let delegate = try TrustDelegate(rootPath: args[2], identityPath: args[3])
   let config = URLSessionConfiguration.ephemeral
   config.timeoutIntervalForRequest = 5
   config.urlCredentialStorage = nil
   config.urlCache = nil
   config.httpCookieStorage = nil
   let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
   defer { session.invalidateAndCancel() }
   let (data, response) = try await session.data(for: URLRequest(url: URL(string: args[1])!), delegate: delegate)
   print("\((response as! HTTPURLResponse).statusCode) \(String(decoding: data, as: UTF8.self))")
  } catch { print("TLS_REJECTED \((error as NSError).code)") }
 }
}

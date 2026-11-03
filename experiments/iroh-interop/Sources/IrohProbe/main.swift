import Foundation
import IrohLib

// Offline compatibility probe only: never constructs or binds an Endpoint.
struct Input: Decodable { let seed: [UInt8]; let message: [UInt8]; let signature: [UInt8] }
struct Output: Encodable { let publicKey: [UInt8]; let signature: [UInt8]; let verified: Bool }
let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
let key = try SecretKey.fromBytes(bytes: Data(input.seed))
let message = Data(input.message)
try key.public().verify(message: message, signature: Signature.fromBytes(bytes: Data(input.signature)))
let output = Output(publicKey: Array(key.public().toBytes()), signature: Array(key.sign(message: message).toBytes()), verified: true)
FileHandle.standardOutput.write(try JSONEncoder().encode(output))

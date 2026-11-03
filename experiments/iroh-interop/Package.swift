// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "IrohProbe", platforms: [.macOS("14.5")], dependencies: [.package(url: "https://github.com/n0-computer/iroh-ffi", exact: "1.2.0")], targets: [.executableTarget(name: "IrohProbe", dependencies: [.product(name: "IrohLib", package: "iroh-ffi")])])

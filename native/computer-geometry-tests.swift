import Foundation
import CoreGraphics

// Permission-free executable exercising the production ComputerGeometry.
// Compiled only by tests/computer-geometry.test.ts; not bundled with the app.
@main
struct ComputerGeometryChecks {
    static func coordinates(_ points: [CGPoint]) -> [[Double]] {
        points.map { [Double($0.x), Double($0.y)] }
    }
    static func rejection(_ operation: () throws -> Void) -> String {
        do {
            try operation()
            return "accepted"
        } catch {
            return String(describing: error)
        }
    }
    static func main() throws {
        let geometry = ComputerGeometry(bounds: CGRect(x: 296, y: 139, width: 1440, height: 880), width: 1440, height: 880)
        let result: [String: Any]
        switch CommandLine.arguments.dropFirst().first {
        case "reported":
            result = [
                "vertical": coordinates(try geometry.drag(x: 1019, y: 230, toX: 1019, toY: 195)),
                "small": coordinates(try geometry.drag(x: 900, y: 300, toX: 910, toY: 310)),
                "start": coordinates([try geometry.point(x: 1019, y: 230)]),
                "end": coordinates([try geometry.point(x: 1019, y: 195)])
            ]
        case "retina":
            let retina = ComputerGeometry(bounds: CGRect(x: 100, y: 50, width: 720, height: 440), width: 1440, height: 880)
            result = ["path": coordinates(try retina.drag(x: 1019, y: 230, toX: 1019, toY: 195))]
        case "secondary":
            let secondary = ComputerGeometry(bounds: CGRect(x: -1920, y: -1080, width: 1920, height: 1080), width: 1440, height: 810)
            result = ["path": coordinates(try secondary.drag(x: 0, y: 0, toX: 1439, toY: 809, steps: 3))]
        case "borders":
            let invalid: [(Double, Double)] = [(-1, 0), (0, -1), (1440, 0), (0, 880), (.infinity, 0), (0, -.infinity), (.nan, 0), (0, .nan)]
            result = [
                "corners": coordinates([try geometry.point(x: 0, y: 0), try geometry.point(x: 1439, y: 879)]),
                "pointErrors": invalid.map { x, y in rejection { _ = try geometry.point(x: x, y: y) } },
                "startErrors": invalid.map { x, y in rejection { _ = try geometry.drag(x: x, y: y, toX: 1, toY: 1) } },
                "endErrors": invalid.map { x, y in rejection { _ = try geometry.drag(x: 1, y: 1, toX: x, toY: y) } }
            ]
        case "invalid-geometry":
            let invalid = [
                ComputerGeometry(bounds: geometry.bounds, width: 0, height: 880),
                ComputerGeometry(bounds: geometry.bounds, width: 1440, height: 0),
                ComputerGeometry(bounds: CGRect(x: 0, y: 0, width: 0, height: 880), width: 1440, height: 880),
                ComputerGeometry(bounds: CGRect(x: 0, y: 0, width: 1440, height: 0), width: 1440, height: 880),
                ComputerGeometry(bounds: CGRect(x: CGFloat.infinity, y: 0, width: 1440, height: 880), width: 1440, height: 880),
                ComputerGeometry(bounds: CGRect(x: 0, y: CGFloat.nan, width: 1440, height: 880), width: 1440, height: 880),
                ComputerGeometry(bounds: CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 880), width: 1440, height: 880)
            ]
            result = ["errors": invalid.map { item in rejection { _ = try item.point(x: 1, y: 1) } }]
        case "steps":
            result = [
                "one": coordinates(try geometry.drag(x: 100, y: 100, toX: 200, toY: 300, steps: 1)),
                "four": coordinates(try geometry.drag(x: 100, y: 100, toX: 200, toY: 300, steps: 4)),
                "stationary": coordinates(try geometry.drag(x: 100, y: 100, toX: 100, toY: 100)),
                "maximum": coordinates(try geometry.drag(x: 0, y: 0, toX: 1439, toY: 879, steps: 100)),
                "errors": [-1, 0, 101].map { count in rejection { _ = try geometry.drag(x: 0, y: 0, toX: 1, toY: 1, steps: count) } }
            ]
        default:
            throw Failure("Unknown geometry test case.")
        }
        let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
    }
}

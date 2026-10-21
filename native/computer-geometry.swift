import Foundation
import CoreGraphics

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}
// All public coordinates are pixels in the returned image. Keep interpolation
// typed so CGFloat values never cross a JSON-style Double cast (the old drag bug).
struct ComputerGeometry {
    let bounds: CGRect
    let width: Int
    let height: Int

    func point(x: Double, y: Double) throws -> CGPoint {
        guard width > 0, height > 0, bounds.width > 0, bounds.height > 0,
              [bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy({ $0.isFinite }),
              x.isFinite, y.isFinite, x >= 0, y >= 0, x < Double(width), y < Double(height) else {
            throw Failure("Coordinates must be inside the observed image.")
        }
        return CGPoint(x: bounds.minX + x * bounds.width / Double(width),
                       y: bounds.minY + y * bounds.height / Double(height))
    }
    func drag(x: Double, y: Double, toX: Double, toY: Double, steps: Int = 12) throws -> [CGPoint] {
        let start = try point(x: x, y: y), end = try point(x: toX, y: toY)
        guard steps > 0, steps <= 100 else { throw Failure("Invalid drag step count.") }
        return (0...steps).map { step in
            let t = Double(step) / Double(steps)
            return CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        }
    }
}

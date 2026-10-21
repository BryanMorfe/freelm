import AppKit
import ApplicationServices
import Foundation

// Constructs production events without posting input, requesting permissions,
// showing windows, or activating the process. The optional AppKit roundtrip
// needs a WindowServer connection, but all other cases also run headlessly.
@main
struct ComputerInputChecks {
    typealias GetLocation = @convention(c) (CGEvent) -> CGPoint
    static let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_LOCAL)
    static func windowLocation(_ event: CGEvent) throws -> CGPoint {
        guard let library, let symbol = dlsym(library, "CGEventGetWindowLocation") else {
            throw Failure("Window-location inspection is unavailable.")
        }
        return unsafeBitCast(symbol, to: GetLocation.self)(event)
    }
    static func coordinates(_ point: CGPoint) -> [Double] { [Double(point.x), Double(point.y)] }
    static func fields(_ event: CGEvent) throws -> [String: Any] {
        [
            "global": coordinates(event.location),
            "local": coordinates(try windowLocation(event)),
            "type": event.type.rawValue,
            "pid": event.getIntegerValueField(.eventTargetUnixProcessID),
            "window": event.getIntegerValueField(CGEventField(rawValue: 51)!),
            "underPointer": event.getIntegerValueField(.mouseEventWindowUnderMousePointer),
            "canHandle": event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent),
            "eventNumber": event.getIntegerValueField(.mouseEventNumber),
            "clickCount": event.getIntegerValueField(.mouseEventClickState),
            "subtype": event.getIntegerValueField(.mouseEventSubtype),
            "flags": event.flags.rawValue,
            "timestamp": event.timestamp
        ]
    }
    static func rejection(_ body: () throws -> Void) -> Bool {
        do { try body(); return false } catch { return true }
    }
    static func main() throws {
        let bounds = CGRect(x: 296, y: 139, width: 1440, height: 880)
        let target = WindowInputTarget(pid: 1234, window: 5678, bounds: bounds)
        let point = CGPoint(x: 1315, y: 369)
        let result: [String: Any]
        switch CommandLine.arguments.dropFirst().first {
        case "environment":
            let cases: [(String, [String: Any]?, [Bool]?)] = [
                ("unknown", nil, nil),
                ("awake", [kCGSessionOnConsoleKey as String: true, kCGSessionLoginDoneKey as String: true], [false]),
                ("locked", ["CGSSessionScreenIsLocked": true, kCGSessionOnConsoleKey as String: false], [true]),
                ("otherSession", [kCGSessionOnConsoleKey as String: false], [false]),
                ("loggedOut", [kCGSessionLoginDoneKey as String: false], [false]),
                ("asleep", ["CGSSessionScreenIsLocked": false], [true, true]),
                ("oneAwake", ["CGSSessionScreenIsLocked": false], [true, false]),
                ("noDisplays", [:], []),
            ]
            result = Dictionary(uniqueKeysWithValues: cases.map { name, session, displays in
                let environment = ComputerEnvironment(session: session, displaySleepStates: displays)
                var row = environment.json
                row["blocked"] = rejection { try environment.requireInteractive() }
                if let message = environment.blockingMessage { row["message"] = message }
                return (name, row)
            })
        case "pointer":
            var rows: [[String: Any]] = []
            for type: CGEventType in [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged] {
                let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)!
                event.setIntegerValueField(.mouseEventClickState, value: 2)
                event.setIntegerValueField(.mouseEventNumber, value: 42)
                event.flags = [.maskShift]
                event.timestamp = 0
                let before = DispatchTime.now().uptimeNanoseconds
                try WindowInput.prepare(event, target: target, point: point)
                let after = DispatchTime.now().uptimeNanoseconds
                var row = try fields(event)
                row["freshTimestamp"] = event.timestamp >= before && event.timestamp <= after
                rows.append(row)
            }
            result = ["events": rows]
        case "scroll":
            let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 135, wheel2: -72, wheel3: 0)!
            event.flags = []
            try WindowInput.prepare(event, target: target, point: point)
            var row = try fields(event)
            row["vertical"] = event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1)
            row["horizontal"] = event.getIntegerValueField(.scrollWheelEventPointDeltaAxis2)
            result = row
        case "secondary":
            let secondary = WindowInputTarget(pid: 1234, window: 5678, bounds: CGRect(x: -1920, y: -1080, width: 1920, height: 1080))
            let point = CGPoint(x: -543.25, y: -234.5)
            let event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)!
            try WindowInput.prepare(event, target: secondary, point: point)
            result = try fields(event)
        case "keyboard":
            let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)!
            let text = Array("A🦉".utf16)
            event.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
            event.flags = [.maskShift]
            event.timestamp = 0
            let before = DispatchTime.now().uptimeNanoseconds
            try WindowInput.prepare(event, target: target, point: nil)
            let after = DispatchTime.now().uptimeNanoseconds
            var actual = [UniChar](repeating: 0, count: 16)
            var count = 0
            event.keyboardGetUnicodeString(maxStringLength: actual.count, actualStringLength: &count, unicodeString: &actual)
            var row = try fields(event)
            row["unicode"] = String(utf16CodeUnits: actual, count: count)
            row["freshTimestamp"] = event.timestamp >= before && event.timestamp <= after
            event.timestamp = 123456789
            try WindowInput.prepare(event, target: target, point: nil)
            row["existingTimestamp"] = event.timestamp
            result = row
        case "invalid":
            let invalidTargets = [
                WindowInputTarget(pid: 0, window: 5678, bounds: bounds),
                WindowInputTarget(pid: 1234, window: 0, bounds: bounds),
                WindowInputTarget(pid: 1234, window: 5678, bounds: CGRect(x: 0, y: 0, width: 0, height: 880)),
                WindowInputTarget(pid: 1234, window: 5678, bounds: CGRect(x: CGFloat.infinity, y: 0, width: 1440, height: 880))
            ]
            result = [
                "targets": invalidTargets.map { item in rejection {
                    let event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)!
                    try WindowInput.prepare(event, target: item, point: point)
                } },
                "points": [
                    CGPoint(x: CGFloat.nan, y: 0), CGPoint(x: 0, y: CGFloat.infinity),
                    CGPoint(x: bounds.minX - 1, y: point.y), CGPoint(x: bounds.maxX, y: point.y),
                    CGPoint(x: point.x, y: bounds.minY - 1), CGPoint(x: point.x, y: bounds.maxY)
                ].map { point in rejection {
                    let event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: .zero, mouseButton: .left)!
                    try WindowInput.prepare(event, target: target, point: point)
                } }
            ]
        case "roundtrip":
            let app = NSApplication.shared
            _ = app.setActivationPolicy(.prohibited)
            guard let screen = NSScreen.screens.first else {
                throw Failure("AppKit roundtrip needs a WindowServer connection. Run this no-input test on the macOS GUI host outside the filesystem sandbox.")
            }
            let window = NSWindow(contentRect: CGRect(x: 100, y: 150, width: 600, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
            defer { window.close() }
            guard window.windowNumber > 0 else {
                throw Failure("AppKit could not create an unshown test window. Run this no-input test on the macOS GUI host outside the filesystem sandbox.")
            }
            let local = CGPoint(x: 200, y: 100)
            let cocoaScreen = window.convertPoint(toScreen: local)
            let quartz = CGPoint(x: cocoaScreen.x, y: screen.frame.height - cocoaScreen.y)
            let bounds = CGRect(x: window.frame.minX, y: screen.frame.height - window.frame.maxY, width: window.frame.width, height: window.frame.height)
            let ownTarget = WindowInputTarget(pid: getpid(), window: CGWindowID(window.windowNumber), bounds: bounds)
            let event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: quartz, mouseButton: .left)!
            event.flags = []
            try WindowInput.prepare(event, target: ownTarget, point: quartz)
            guard let converted = NSEvent(cgEvent: event) else { throw Failure("NSEvent conversion failed.") }
            let reference = NSEvent.mouseEvent(with: .leftMouseDown, location: local, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 42, clickCount: 1, pressure: 1)!.cgEvent!
            result = [
                "available": true,
                "local": coordinates(converted.locationInWindow),
                "globalMatches": event.location == reference.location,
                "privateLocationMatches": try windowLocation(event) == windowLocation(reference),
                "windowMatches": converted.windowNumber == window.windowNumber,
                "windowVisible": window.isVisible,
                "appActive": app.isActive
            ]
        default:
            throw Failure("Unknown input test case.")
        }
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
    }
}

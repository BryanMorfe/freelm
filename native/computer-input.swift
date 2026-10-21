import AppKit
import ApplicationServices
import Foundation

// Probe only the current user's session and public display power state. Missing
// fields stay unknown: a failed probe is not evidence that the screen is locked.
struct ComputerEnvironment {
    let screenLocked: Bool?
    let sessionActive: Bool?
    let displaysAwake: Bool?

    init(session: [String: Any]?, displaySleepStates: [Bool]?) {
        screenLocked = session?["CGSSessionScreenIsLocked"] as? Bool
        let onConsole = session?[kCGSessionOnConsoleKey as String] as? Bool
        let loggedIn = session?[kCGSessionLoginDoneKey as String] as? Bool
        if onConsole == false || loggedIn == false { sessionActive = false }
        else if onConsole == true && loggedIn == true { sessionActive = true }
        else { sessionActive = nil }
        displaysAwake = displaySleepStates.flatMap { $0.isEmpty ? nil : $0.contains(false) }
    }

    static func current() -> ComputerEnvironment {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        var count: UInt32 = 0
        var sleepStates: [Bool]?
        if CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0, count <= 64 {
            var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
            if CGGetOnlineDisplayList(count, &displays, &count) == .success {
                sleepStates = displays.prefix(Int(count)).map { CGDisplayIsAsleep($0) != 0 }
            }
        }
        return ComputerEnvironment(session: session, displaySleepStates: sleepStates)
    }

    var blockingMessage: String? {
        if screenLocked == true { return "The Mac is locked. Unlock it, then observe the authorized app again. No further input will be sent." }
        if sessionActive == false { return "This macOS user session is not active. Switch back to this user session, then observe the authorized app again. No further input will be sent." }
        if displaysAwake == false { return "All connected displays are asleep. Wake a display, then observe the authorized app again. No further input will be sent." }
        return nil
    }

    var json: [String: Any] {
        var value: [String: Any] = [:]
        if let screenLocked { value["screenLocked"] = screenLocked }
        if let sessionActive { value["sessionActive"] = sessionActive }
        if let displaysAwake { value["displaysAwake"] = displaysAwake }
        return value
    }

    func requireInteractive() throws {
        if let message = blockingMessage { throw Failure(message) }
    }
}

struct WindowInputTarget {
    let pid: pid_t
    let window: CGWindowID
    let bounds: CGRect
}

// Exact-window background delivery. See docs/COMPUTER_USE.md for the SPI
// reference and limits. There is intentionally no HID, activation, cursor warp,
// focus-transfer, or second delivery route if a target rejects these events.
enum WindowInput {
    typealias Post = @convention(c) (pid_t, CGEvent) -> Void
    typealias SetInteger = @convention(c) (CGEvent, UInt32, Int64) -> Void
    typealias SetLocation = @convention(c) (CGEvent, CGPoint) -> Void
    private static let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_LOCAL)
    private static func resolve<T>(_ name: String, _: T.Type) -> T? {
        guard let library, let symbol = dlsym(library, name) else { return nil }
        return unsafeBitCast(symbol, to: T.self)
    }
    private static let postEvent = resolve("SLEventPostToPid", Post.self)
    private static let setInteger = resolve("SLEventSetIntegerValueField", SetInteger.self)
    private static let setLocation = resolve("CGEventSetWindowLocation", SetLocation.self)
    static var available: Bool { postEvent != nil && setInteger != nil && setLocation != nil }

    // Prepare separately from delivery so native tests can round-trip the actual
    // CGEvent through NSEvent without posting input or requiring OS grants.
    static func prepare(_ event: CGEvent, target: WindowInputTarget, point: CGPoint?) throws {
        guard target.pid > 0, target.window > 0,
              [target.bounds.minX, target.bounds.minY, target.bounds.width, target.bounds.height].allSatisfy({ $0.isFinite }),
              target.bounds.width > 0, target.bounds.height > 0,
              let setInteger, let setLocation else {
            throw Failure("Independent window input is unavailable for this target. No desktop input was sent.")
        }
        if let point {
            guard point.x.isFinite, point.y.isFinite, target.bounds.contains(point) else {
                throw Failure("Input coordinates must remain inside the observed window.")
            }
        }
        setInteger(event, 40, Int64(target.pid))
        setInteger(event, 51, Int64(target.window))
        if let point {
            event.location = point
            // Quartz's global location and AppKit's window location are distinct.
            // The latter uses points from the window's top-left, not desktop
            // points or screenshot pixels (which may be Retina-scaled).
            setLocation(event, CGPoint(x: point.x - target.bounds.minX, y: point.y - target.bounds.minY))
            setInteger(event, 91, Int64(target.window))
            setInteger(event, 92, Int64(target.window))
        }
        // Fresh CGEvent constructors can have a zero timestamp. Set the public
        // timestamp once per event; never reuse one value for an entire gesture.
        if event.timestamp == 0 { event.timestamp = DispatchTime.now().uptimeNanoseconds }
        // Preserve native event kind, subtype and click count. Raw field 58 is
        // the timestamp, not a gesture-group ID.
    }

    static func send(_ event: CGEvent, target: WindowInputTarget, point: CGPoint?) throws {
        guard let postEvent else {
            throw Failure("Independent window input is unavailable on this macOS version. No desktop input was sent.")
        }
        try prepare(event, target: target, point: point)
        // This is a dispatch, not a receipt. Never retry via global input.
        postEvent(target.pid, event)
    }
}

// Cancellation releases a held drag through the same exact-window route.
// It must never release the user's physical mouse button or change app focus.
enum InputSafety {
    static let lock = NSLock()
    static var cancelled = false
    static var held: (target: WindowInputTarget, point: CGPoint)?
    static func pair(_ down: CGEvent?, _ up: CGEvent?, target: WindowInputTarget, point: CGPoint? = nil) throws {
        lock.lock(); defer { lock.unlock() }
        guard !cancelled else { throw Failure("Computer Use was stopped.") }
        guard let down, let up else { throw Failure("macOS could not create an input event.") }
        try WindowInput.send(down, target: target, point: point)
        if point != nil { Thread.sleep(forTimeInterval: 0.028) }
        try WindowInput.send(up, target: target, point: point)
    }
    static func post(_ event: CGEvent?, target: WindowInputTarget, point: CGPoint? = nil, hold: Bool = false) throws {
        lock.lock(); defer { lock.unlock() }
        guard !cancelled else { throw Failure("Computer Use was stopped.") }
        guard let event else { throw Failure("macOS could not create an input event.") }
        try WindowInput.send(event, target: target, point: point)
        if hold, let point { held = (target, point) }
    }
    private static func releaseLocked() {
        guard let target = held else { return }
        held = nil
        if let event = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: .leftMouseUp, mouseCursorPosition: target.point, mouseButton: .left) {
            event.flags = []
            event.setIntegerValueField(.mouseEventClickState, value: 1)
            event.setIntegerValueField(.mouseEventButtonNumber, value: 0)
            try? WindowInput.send(event, target: target.target, point: target.point)
        }
    }
    static func release() {
        lock.lock(); defer { lock.unlock() }
        releaseLocked()
    }
    static func cancel() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true
        releaseLocked()
    }
}

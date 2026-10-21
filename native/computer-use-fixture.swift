import AppKit
import Foundation
import WebKit

// A disposable, offline UI used only by the explicit Computer Use native smoke.
// The native file panel starts in the smoke's temporary directory; the fixture
// never reads selected files, opens remote URLs, or uses the pasteboard. Its
// WebKit page is a generated local file in the same disposable directory.
final class FixtureMarker: NSView {
    var generation = 0 { didSet { needsDisplay = true } }
    var rgb: [Int] { generation % 2 == 0 ? [32, 200, 220] : [220, 40, 190] }
    override func draw(_ dirtyRect: NSRect) {
        let color = rgb
        NSColor(srgbRed: CGFloat(color[0]) / 255, green: CGFloat(color[1]) / 255, blue: CGFloat(color[2]) / 255, alpha: 1).setFill()
        bounds.fill()
    }
}
final class FixtureDragTarget: NSView {
    var changed: (() -> Void)?
    private(set) var events: [[String: Any]] = []
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemBlue.withAlphaComponent(0.25).setFill()
        bounds.fill()
        ("Native drag target" as NSString).draw(at: NSPoint(x: 16, y: 12), withAttributes: [.font: NSFont.systemFont(ofSize: 16), .foregroundColor: NSColor.labelColor])
    }
    private func record(_ kind: String, _ event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let pointer = NSEvent.mouseLocation
        events.append(["kind": kind, "x": point.x, "y": point.y,
                       "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
                       "physicalPointer": ["x": pointer.x, "y": pointer.y]])
        changed?()
    }
    override func mouseDown(with event: NSEvent) { record("down", event) }
    override func mouseDragged(with event: NSEvent) { record("drag", event) }
    override func mouseUp(with event: NSEvent) { record("up", event) }
}
final class FixtureDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate, NSOpenSavePanelDelegate, NSOutlineViewDataSource, NSOutlineViewDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var window: NSWindow!
    private let input = NSTextField()
    private let result = NSTextField(labelWithString: "No text applied")
    private let marker = FixtureMarker()
    private let dragTarget = FixtureDragTarget()
    private let choices = [NSString(string: "Fixture choice Alpha"), NSString(string: "Fixture choice Beta")]
    private let outline = NSOutlineView()
    private var panel: NSOpenPanel?
    private var clicks = 0
    private var selectedChoice = ""
    private var inputEventFrontmostPids: [pid_t] = []
    private var activationPids: [pid_t] = []
    private var activationObserver: NSObjectProtocol?
    private var panelCancelled = false
    private var directoryURL: URL?
    private var stateURL: URL?
    private var lastState: Data?
    private var sampleTimer: Timer?
    private var webView: WKWebView?
    private var webPageURL: URL?
    private var webState: [String: Any] = ["ready": false]
    private var webEventContext: [[String: Any]] = []
    private var webSamplePending = false
    private var webSampleCount = 0
    private var webVisible = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Foundation can preserve /var while Node realpath uses /private/var.
        // Compare canonical filesystem parents, including the not-yet-created
        // state file, so this safety check does not silently disable the oracle.
        func canonicalURL(_ url: URL) -> URL? {
            let exists = FileManager.default.fileExists(atPath: url.path)
            let existing = exists ? url : url.deletingLastPathComponent()
            guard let pointer = realpath(existing.path, nil) else { return nil }
            defer { free(pointer) }
            let resolved = URL(fileURLWithPath: String(cString: pointer))
            return exists ? resolved : resolved.appendingPathComponent(url.lastPathComponent)
        }
        guard let temporary = canonicalURL(URL(fileURLWithPath: NSTemporaryDirectory())) else { NSApp.terminate(nil); return }
        func temporaryURL(_ key: String) -> URL? {
            guard let configured = Bundle.main.object(forInfoDictionaryKey: key) as? String,
                  let candidate = canonicalURL(URL(fileURLWithPath: configured)) else { return nil }
            return candidate.path.hasPrefix(temporary.path + "/") ? candidate : nil
        }
        stateURL = temporaryURL("FreeLMFixtureStatePath")
        directoryURL = temporaryURL("FreeLMFixtureDirectoryPath")
        guard stateURL != nil, directoryURL != nil else {
            FileHandle.standardError.write(Data("Fixture paths must be under its temporary directory: \(temporary.path).\n".utf8))
            NSApp.terminate(nil)
            return
        }
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] notification in
            guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.activationPids.append(application.processIdentifier)
            self?.writeState()
        }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 420), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "FreeLM Computer Use Test"
        let body = NSView(frame: NSRect(x: 0, y: 0, width: 760, height: 420))
        let title = NSTextField(labelWithString: "Disposable Computer Use fixture")
        title.font = .systemFont(ofSize: 18, weight: .semibold)
        title.frame = NSRect(x: 30, y: 345, width: 700, height: 32)
        body.addSubview(title)
        input.frame = NSRect(x: 30, y: 280, width: 700, height: 34)
        input.font = .systemFont(ofSize: 16)
        input.placeholderString = "Type fixture text here"
        input.setAccessibilityLabel("Fixture input")
        input.setAccessibilityIdentifier("fixture-input")
        input.delegate = self
        body.addSubview(input)
        let button = NSButton(title: "Apply fixture text", target: self, action: #selector(applyText))
        button.bezelStyle = .rounded
        button.frame = NSRect(x: 30, y: 220, width: 180, height: 34)
        button.setAccessibilityIdentifier("fixture-apply")
        body.addSubview(button)
        let open = NSButton(title: "Open fixture sheet", target: self, action: #selector(openSheet))
        open.bezelStyle = .rounded
        open.frame = NSRect(x: 240, y: 220, width: 180, height: 34)
        body.addSubview(open)
        let openWeb = NSButton(title: "Open WebKit fixture", target: self, action: #selector(openWebFixture))
        openWeb.bezelStyle = .rounded
        openWeb.frame = NSRect(x: 450, y: 220, width: 220, height: 34)
        body.addSubview(openWeb)
        result.frame = NSRect(x: 30, y: 160, width: 700, height: 32)
        result.font = .systemFont(ofSize: 15)
        result.setAccessibilityLabel("Fixture result")
        result.setAccessibilityIdentifier("fixture-result")
        body.addSubview(result)
        dragTarget.frame = NSRect(x: 30, y: 58, width: 700, height: 72)
        dragTarget.setAccessibilityElement(true)
        dragTarget.setAccessibilityLabel("Fixture drag target")
        dragTarget.changed = { [weak self] in self?.writeState() }
        body.addSubview(dragTarget)
        window.contentView = body
        prepareWebFixture()
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(input)
        NSApp.activate()
        // The independent state oracle observes real AppKit geometry after sheet
        // animations. No Computer Use AX or screenshot result is used here.
        sampleTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.sampleWebFixture()
            self?.writeState()
        }
        writeState()
    }
    private func prepareWebFixture() {
        guard let directoryURL else { return }
        let pageURL = directoryURL.appendingPathComponent("webkit-fixture.html")
        do {
            try Self.webFixtureHTML.write(to: pageURL, atomically: true, encoding: .utf8)
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.userContentController.add(self, name: "fixture")
            let view = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
            view.navigationDelegate = self
            view.setAccessibilityLabel("WebKit fixture")
            webPageURL = pageURL
            webView = view
            view.loadFileURL(pageURL, allowingReadAccessTo: pageURL)
        } catch {
            webState = ["ready": false, "error": error.localizedDescription]
        }
    }
    @objc private func openWebFixture() {
        guard let webView, let body = window.contentView else { return }
        webVisible = true
        webView.frame = body.bounds
        body.addSubview(webView)
        writeState()
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url?.standardizedFileURL == webPageURL?.standardizedFileURL ? .allow : .cancel)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "fixture", message.frameInfo.isMainFrame,
              let state = message.body as? [String: Any] else { return }
        let previousCount = (webState["events"] as? [[String: Any]])?.count ?? 0
        let nextCount = (state["events"] as? [[String: Any]])?.count ?? 0
        if nextCount > previousCount {
            let pointer = NSEvent.mouseLocation
            webEventContext.append(["fromEvent": previousCount, "toEvent": nextCount,
                                    "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
                                    "physicalPointer": ["x": pointer.x, "y": pointer.y]])
        }
        webState = state
        writeState()
    }
    private func sampleWebFixture() {
        guard webVisible, !webSamplePending, let webView else { return }
        webSamplePending = true
        // Read the actual DOM again even if an AX setter generated no input
        // event. This oracle never focuses a control or mutates its value.
        webView.evaluateJavaScript("window.fixturePublish && window.fixturePublish()") { [weak self] _, _ in
            self?.webSamplePending = false
            self?.webSampleCount += 1
            self?.writeState()
        }
    }
    private static let webFixtureHTML = #"""
    <!doctype html><html lang="en"><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'">
    <title>Disposable WebKit fixture</title>
    <style>
    :root { --font-size-ui: 16px; color-scheme: light dark; font: var(--font-size-ui) system-ui; }
    body { margin: 24px; } h1 { margin: 0 0 16px; font-size: 20px; }
    label { display: block; margin: 12px 0; } input, button { font: var(--font-size-ui) system-ui; padding: 8px; }
    input { width: 440px; } button { margin-right: 12px; }
    #web-drag { height: 72px; margin-top: 20px; padding: 12px; box-sizing: border-box; background: #1e78c744; user-select: none; }
    #web-nested-label { display: inline-block; padding: 4px 16px; }
    #web-result { margin-top: 12px; }
    </style>
    <h1>Disposable WebKit fixture</h1>
    <label>WebKit typing input <input id="web-input" aria-label="WebKit typing input" autocomplete="off"></label>
    <form id="web-form"><label>WebKit value input <input id="web-value" name="fixture-value" aria-label="WebKit value input" autocomplete="off"></label></form>
    <button id="web-button" aria-label="WebKit nested button"><span id="web-nested-label">Nested button label</span></button>
    <button id="web-blur" aria-label="WebKit blur button">Commit input</button>
    <div id="web-drag" role="group" aria-label="WebKit drag target">WebKit drag target</div>
    <div id="web-result" aria-live="polite">No WebKit clicks</div>
    <script>
    (() => {
      const events = [];
      let clicks = 0;
      let submittedValue = null;
      const controls = ['web-input', 'web-value', 'web-button', 'web-nested-label', 'web-blur', 'web-drag'];
      let lastSnapshot = '';
      window.fixturePublish = () => {
        const bounds = Object.fromEntries(controls.map(id => {
          const rect = document.getElementById(id).getBoundingClientRect();
          return [id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
        }));
        const state = { ready: true, url: location.href, text: document.getElementById('web-input').value,
          value: document.getElementById('web-value').value, activeElement: document.activeElement?.id || '',
          clicks, submittedValue, events, bounds };
        const snapshot = JSON.stringify(state);
        if (snapshot !== lastSnapshot) {
          lastSnapshot = snapshot;
          window.webkit.messageHandlers.fixture.postMessage(state);
        }
      };
      for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'keydown', 'keyup', 'beforeinput', 'input', 'change', 'focusin', 'focusout']) {
        document.addEventListener(type, event => {
          if (!controls.includes(event.target.id)) return;
          events.push({ type, target: event.target.id, x: event.clientX ?? null, y: event.clientY ?? null,
            button: event.button ?? null, buttons: event.buttons ?? null, key: event.key ?? null,
            data: event.data ?? null, inputType: event.inputType ?? null, isTrusted: event.isTrusted });
          queueMicrotask(window.fixturePublish);
        }, true);
      }
      document.getElementById('web-button').addEventListener('click', () => {
        clicks++;
        document.getElementById('web-result').textContent = `WebKit clicks: ${clicks}`;
        window.fixturePublish();
      });
      document.getElementById('web-blur').addEventListener('click', () => {
        submittedValue = new FormData(document.getElementById('web-form')).get('fixture-value');
        window.fixturePublish();
      });
      window.fixturePublish();
    })();
    </script></html>
    """#
    func controlTextDidChange(_ notification: Notification) {
        inputEventFrontmostPids.append(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
        writeState()
    }
    @objc private func applyText() {
        clicks += 1
        result.stringValue = "Applied: \(input.stringValue) (\(clicks))"
        writeState()
    }
    @objc private func openSheet() {
        guard panel == nil, let directoryURL else { return }
        let next = NSOpenPanel()
        next.title = "Fixture Open"
        next.message = "Disposable fixture files only"
        next.prompt = "Select fixture file"
        next.directoryURL = directoryURL
        next.canChooseFiles = true
        next.canChooseDirectories = false
        next.allowsMultipleSelection = false
        next.canCreateDirectories = false
        next.delegate = self
        let accessory = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 110))
        marker.frame = NSRect(x: 12, y: 22, width: 90, height: 64)
        marker.generation = 0
        accessory.addSubview(marker)
        let refresh = NSButton(title: "Refresh sheet marker", target: self, action: #selector(refreshMarker))
        refresh.bezelStyle = .rounded
        refresh.frame = NSRect(x: 112, y: 36, width: 200, height: 34)
        accessory.addSubview(refresh)
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("fixture-choice"))
        column.width = 286
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.frame = NSRect(x: 0, y: 0, width: 296, height: 72)
        outline.rowHeight = 30
        outline.allowsMultipleSelection = false
        outline.dataSource = self
        outline.delegate = self
        outline.setAccessibilityLabel("Fixture selectable rows")
        let scroll = NSScrollView(frame: NSRect(x: 332, y: 20, width: 296, height: 72))
        scroll.documentView = outline
        accessory.addSubview(scroll)
        outline.reloadData()
        next.accessoryView = accessory
        next.isAccessoryViewDisclosed = true
        panel = next
        panelCancelled = false
        next.beginSheetModal(for: window) { [weak self] response in
            self?.panelCancelled = response == .cancel
            self?.panel = nil
            self?.writeState()
        }
        writeState()
    }
    @objc private func refreshMarker() {
        marker.generation += 1
        writeState()
    }
    func panel(_ sender: Any, didChangeToDirectoryURL url: URL?) { writeState() }
    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { item == nil ? choices.count : 0 }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { choices[index] }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { false }
    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        let text = NSTextField(labelWithString: item as? String ?? "")
        text.font = .systemFont(ofSize: 14)
        text.setAccessibilityLabel(text.stringValue)
        return text
    }
    func outlineViewSelectionDidChange(_ notification: Notification) {
        selectedChoice = outline.selectedRow >= 0 ? choices[outline.selectedRow] as String : ""
        writeState()
    }
    private func screenBounds(_ frame: NSRect) -> [String: Double] {
        let desktopTop = NSScreen.screens.first?.frame.maxY ?? 0
        return ["x": frame.minX, "y": desktopTop - frame.maxY, "width": frame.width, "height": frame.height]
    }
    private func writeState() {
        guard let stateURL else { return }
        var state: [String: Any] = ["text": input.stringValue, "clicks": clicks, "result": result.stringValue, "ready": true, "pid": ProcessInfo.processInfo.processIdentifier, "panelOpen": panel?.isVisible == true, "panelCancelled": panelCancelled, "selection": selectedChoice]
        let pointer = NSEvent.mouseLocation
        state["frontmostPid"] = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        state["physicalPointer"] = ["x": pointer.x, "y": pointer.y]
        state["inputEventFrontmostPids"] = inputEventFrontmostPids
        state["activationPids"] = activationPids
        state["windowBounds"] = screenBounds(window.frame)
        state["windowId"] = window.windowNumber
        state["drag"] = ["events": dragTarget.events,
                         "bounds": screenBounds(window.convertToScreen(dragTarget.convert(dragTarget.bounds, to: nil)))]
        var web = webState
        web["visible"] = webVisible
        web["eventContext"] = webEventContext
        web["sampleCount"] = webSampleCount
        if let webView, webView.window != nil {
            web["viewBounds"] = screenBounds(window.convertToScreen(webView.convert(webView.bounds, to: nil)))
        }
        state["web"] = web
        if let panel, panel.isVisible {
            state["panelBounds"] = screenBounds(panel.frame)
            state["panelWindowId"] = panel.windowNumber
            state["directory"] = panel.directoryURL?.standardizedFileURL.resolvingSymlinksInPath().path ?? ""
            if let markerWindow = marker.window {
                state["marker"] = ["generation": marker.generation, "rgb": marker.rgb, "bounds": screenBounds(markerWindow.convertToScreen(marker.convert(marker.bounds, to: nil)))]
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]), data != lastState else { return }
        try? data.write(to: stateURL, options: .atomic)
        lastState = data
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
@main struct Fixture {
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let delegate = FixtureDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}

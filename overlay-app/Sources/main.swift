// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── A.T.L.A.S Native Overlay ────────────────────
// Lightweight macOS overlay window using WKWebView.
// No third-party dependencies — AppKit + WebKit only.
// Connects to the overlay HTTP/WebSocket server at 127.0.0.1:18792.

import AppKit
import WebKit

// MARK: - Constants

private let overlayURL = "http://127.0.0.1:18792"
private let overlayWidth: CGFloat = 340
private let overlayMinHeight: CGFloat = 56
private let overlayMaxHeight: CGFloat = 500
private let overlayMarginRight: CGFloat = 16
private let overlayMarginTop: CGFloat = 8
private let resizeInterval: TimeInterval = 0.3
private let hideAnimationDuration: TimeInterval = 0.25

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var resizeTimer: Timer?
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var isHiding = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupWindow()
        setupWebView()
        registerHotkeys()
        startResizePolling()

        // Wait for server to be ready, then show
        waitForServer { [weak self] in
            self?.showOverlay()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        resizeTimer?.invalidate()
    }

    // MARK: - Window Setup

    private func setupWindow() {
        let frame = overlayFrame(height: overlayMinHeight)

        window = NSWindow(
            contentRect: frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.level = .floating
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isMovableByWindowBackground = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.isReleasedWhenClosed = false
        window.animationBehavior = .utilityWindow

        // Auto-hide when window loses focus
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(windowDidResignKey),
            name: NSWindow.didResignKeyNotification,
            object: window
        )
    }

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = false

        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]

        // Transparent background
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear

        // Block external navigation — open in default browser instead
        webView.navigationDelegate = self

        window.contentView?.addSubview(webView)
    }

    // MARK: - Overlay Position

    private func overlayFrame(height: CGFloat) -> NSRect {
        guard let screen = NSScreen.main else {
            return NSRect(x: 100, y: 100, width: overlayWidth, height: height)
        }
        let visible = screen.visibleFrame
        let x = visible.maxX - overlayWidth - overlayMarginRight
        let y = visible.maxY - height - overlayMarginTop
        return NSRect(x: x, y: y, width: overlayWidth, height: height)
    }

    // MARK: - Show / Hide / Toggle

    func showOverlay() {
        isHiding = false

        // Reposition to current screen
        let frame = overlayFrame(height: overlayMinHeight)
        window.setFrame(frame, display: false)

        // Reload if webview is blank (first show or after error)
        if webView.url == nil {
            webView.load(URLRequest(url: URL(string: overlayURL)!))
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeFirstResponder(webView)

        // Focus the input field
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.webView.evaluateJavaScript(
                "document.getElementById('input')?.focus();",
                completionHandler: nil
            )
        }
    }

    func hideOverlay() {
        guard window.isVisible, !isHiding else { return }
        isHiding = true

        // Spring-out animation via JS (matches Hammerspoon/Electron behavior)
        webView.evaluateJavaScript("""
            (function() {
                var ib = document.getElementById('input-box');
                var rb = document.getElementById('reply-box');
                var anim = 'springOut 0.25s cubic-bezier(0.55, 0, 1, 0.45) forwards';
                if (ib) ib.style.animation = anim;
                if (rb) rb.style.animation = anim;
            })();
        """, completionHandler: nil)

        DispatchQueue.main.asyncAfter(deadline: .now() + hideAnimationDuration) { [weak self] in
            guard let self else { return }
            self.window.orderOut(nil)

            // Reset animations for next show
            self.webView.evaluateJavaScript("""
                (function() {
                    var ib = document.getElementById('input-box');
                    var rb = document.getElementById('reply-box');
                    if (ib) ib.style.animation = '';
                    if (rb) rb.style.animation = '';
                })();
            """, completionHandler: nil)

            self.isHiding = false
        }
    }

    func toggleOverlay() {
        if window.isVisible && !isHiding {
            hideOverlay()
        } else {
            showOverlay()
        }
    }

    // MARK: - Hotkey Registration

    private func registerHotkeys() {
        // Global monitor — fires when other apps are focused
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handleKeyEvent(event)
        }

        // Local monitor — fires when this app is focused
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if self?.handleKeyEvent(event) == true {
                return nil // Consume the event
            }
            return event
        }
    }

    @discardableResult
    private func handleKeyEvent(_ event: NSEvent) -> Bool {
        // Cmd+J → toggle
        if event.modifierFlags.contains(.command),
           event.charactersIgnoringModifiers == "j" {
            DispatchQueue.main.async { [weak self] in
                self?.toggleOverlay()
            }
            return true
        }

        // Escape → hide (only when overlay is visible)
        if event.keyCode == 53, window.isVisible {
            DispatchQueue.main.async { [weak self] in
                self?.hideOverlay()
            }
            return true
        }

        return false
    }

    // MARK: - Dynamic Height Resize

    private func startResizePolling() {
        resizeTimer = Timer.scheduledTimer(withTimeInterval: resizeInterval, repeats: true) { [weak self] _ in
            self?.pollContentHeight()
        }
    }

    private func pollContentHeight() {
        guard window.isVisible else { return }

        webView.evaluateJavaScript("document.getElementById('container')?.scrollHeight || 0") { [weak self] result, _ in
            guard let self, let scrollHeight = result as? CGFloat, scrollHeight > 0 else { return }

            let newHeight = min(max(scrollHeight + 10, overlayMinHeight), overlayMaxHeight)
            let currentHeight = self.window.frame.height

            // Only resize if the difference is noticeable
            guard abs(currentHeight - newHeight) > 2 else { return }

            let newFrame = self.overlayFrame(height: newHeight)
            self.window.setFrame(newFrame, display: true, animate: false)
        }
    }

    // MARK: - Window Focus Loss

    @objc private func windowDidResignKey(_ notification: Notification) {
        // Small delay to avoid hiding when clicking within the webview
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self, !self.window.isKeyWindow else { return }
            self.hideOverlay()
        }
    }

    // MARK: - Server Readiness Check

    private func waitForServer(attempts: Int = 0, completion: @escaping () -> Void) {
        guard attempts < 30 else {
            NSLog("[ATLAS Overlay] Server not reachable after 30 attempts, showing anyway")
            completion()
            return
        }

        let url = URL(string: "\(overlayURL)/health")!
        let task = URLSession.shared.dataTask(with: url) { _, response, error in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                DispatchQueue.main.async { completion() }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                    self?.waitForServer(attempts: attempts + 1, completion: completion)
                }
            }
        }
        task.resume()
    }
}

// MARK: - Navigation Delegate

extension AppDelegate: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        // Allow loading the overlay itself
        if url.host == "127.0.0.1" && url.port == 18792 {
            decisionHandler(.allow)
            return
        }

        // Open external URLs in default browser
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }
}

// MARK: - Entry Point

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // No dock icon, no menu bar
let delegate = AppDelegate()
app.delegate = delegate
app.run()

-- ⚠️ DEPRECATED — Use the native Swift overlay instead:
--   cd overlay-app && ./build.sh
-- The Swift overlay auto-launches with the backend (npm run dev).
-- This Hammerspoon script is kept for backwards compatibility only.
--
-- A.T.L.A.S Overlay Chat — Hammerspoon Hotkey
-- Cmd+J = toggle, Escape = dismiss

local atlasOverlay = nil
local OVERLAY_URL = "http://127.0.0.1:18792"
local isClosing = false
local resizeTimer = nil

local MAX_WIDTH = 340
local MAX_HEIGHT = 500
local MIN_HEIGHT = 56  -- just the input bar

function showAtlas()
    local screen = hs.screen.mainScreen()
    local f = screen:frame()
    local x = f.x + f.w - MAX_WIDTH - 16
    local y = f.y + 8

    if atlasOverlay then
        atlasOverlay:delete()
        atlasOverlay = nil
    end

    -- Start small (just input bar), will grow dynamically
    atlasOverlay = hs.webview.new(hs.geometry.rect(x, y, MAX_WIDTH, MIN_HEIGHT))
        :windowStyle({"borderless", "closable"})
        :allowTextEntry(true)
        :allowGestures(true)
        :transparent(true)
        :level(hs.drawing.windowLevels.floating)
        :alpha(0.98)
        :shadow(false)
        :navigationCallback(function(action, wv, navID, url)
            -- Allow loading the overlay itself
            if url and not url:find("127.0.0.1:18792") then
                hs.urlevent.openURL(url)
                return false  -- block in-webview navigation
            end
            return true
        end)
        :url(OVERLAY_URL)
        :show()
        :bringToFront(true)

    hs.focus()
    hs.timer.doAfter(0.5, function()
        if atlasOverlay then
            atlasOverlay:evaluateJavaScript("document.getElementById('input').focus();", function() end)
        end
    end)

    -- Start polling content height to resize dynamically
    if resizeTimer then resizeTimer:stop() end
    resizeTimer = hs.timer.doEvery(0.3, function()
        if atlasOverlay and atlasOverlay:isVisible() then
            atlasOverlay:evaluateJavaScript(
                "document.getElementById('container').scrollHeight",
                function(height)
                    if height and type(height) == "number" and height > 0 then
                        local newH = math.min(math.max(height + 10, MIN_HEIGHT), MAX_HEIGHT)
                        local frame = atlasOverlay:frame()
                        if math.abs(frame.h - newH) > 2 then
                            frame.h = newH
                            atlasOverlay:frame(frame)
                        end
                    end
                end
            )
        end
    end)

    isClosing = false
end

function hideAtlas()
    if not atlasOverlay or not atlasOverlay:isVisible() or isClosing then return end
    isClosing = true

    if resizeTimer then resizeTimer:stop(); resizeTimer = nil end

    atlasOverlay:evaluateJavaScript([[
        (function() {
            var ib = document.getElementById('input-box');
            var rb = document.getElementById('reply-box');
            var anim = 'springOut 0.25s cubic-bezier(0.55, 0, 1, 0.45) forwards';
            if (ib) ib.style.animation = anim;
            if (rb) rb.style.animation = anim;
        })();
    ]], function() end)
    hs.timer.doAfter(0.25, function()
        if atlasOverlay then atlasOverlay:hide() end
        isClosing = false
    end)
end

function toggleAtlas()
    if atlasOverlay and atlasOverlay:isVisible() then
        hideAtlas()
    else
        showAtlas()
    end
end

hs.hotkey.bind({"cmd"}, "j", toggleAtlas)

hs.hotkey.bind({}, "escape", function()
    if atlasOverlay and atlasOverlay:isVisible() then
        hideAtlas()
    end
end)

print("✦ A.T.L.A.S overlay: Cmd+J (toggle), Esc (hide)")

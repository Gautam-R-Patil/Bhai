// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";

    function getAcceptanceVersion() {
        if (typeof window !== "undefined" && window.WizardRouter && typeof window.WizardRouter.CURRENT_ACCEPTANCE_VERSION === "string") {
            return window.WizardRouter.CURRENT_ACCEPTANCE_VERSION;
        }
        try {
            const r = require("../router.js");
            if (r && typeof r.CURRENT_ACCEPTANCE_VERSION === "string") return r.CURRENT_ACCEPTANCE_VERSION;
        } catch { /* renderer-only environments fall through */ }
        return "1.0.0";
    }
    const ACCEPTANCE_VERSION = getAcceptanceVersion();
    const DOCUMENTS = [
        { id: "terms", label: "Terms of Service", url: "https://tryatlasagi.com/terms" },
        { id: "privacy", label: "Privacy Policy", url: "https://tryatlasagi.com/privacy" },
        { id: "acceptableUse", label: "Acceptable Use Policy", url: "https://tryatlasagi.com/acceptable-use" },
        { id: "disclaimer", label: "Disclaimer", url: "https://tryatlasagi.com/disclaimer" },
        { id: "refund", label: "Refund Policy", url: "https://tryatlasagi.com/refund" },
    ];

    const SUMMARY_BULLETS = [
        "We don't reverse-engineer or share your data — and you agree not to reverse-engineer, decompile, or extract our prompts, models, or training data.",
        "You won't use ATLAS to build a competing AI service or scrape it for behaviour to train other models.",
        "Your conversations stay yours. We don't train foundation models on them.",
        "ATLAS can take autonomous actions on your behalf — you remain responsible for reviewing and overseeing them.",
        "Disputes are resolved by arbitration in Thiruvananthapuram, India under Indian law. Indian consumer protection rights are preserved.",
    ];

    function buildLink(doc) {
        const a = document.createElement("a");
        a.className = "terms-doc-link";
        a.href = doc.url;
        a.textContent = doc.label;
        a.setAttribute("data-doc-id", doc.id);
        a.setAttribute("rel", "noopener noreferrer");
        a.addEventListener("click", function (ev) {
            ev.preventDefault();
            if (window.atlas && typeof window.atlas.openExternalUrl === "function") {
                window.atlas.openExternalUrl(doc.url).catch(function () {});
            }
        });
        return a;
    }

    function render(root, ctx) {
        const section = document.createElement("section");
        section.className = "step step-terms";

        const title = document.createElement("h2");
        title.className = "step-title";
        title.textContent = "Terms & Privacy";
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = "Before continuing, please review and accept the following.";
        section.appendChild(sub);

        const summary = document.createElement("ul");
        summary.className = "terms-summary";
        SUMMARY_BULLETS.forEach(function (text) {
            const li = document.createElement("li");
            li.textContent = text;
            summary.appendChild(li);
        });
        section.appendChild(summary);

        const linksHeading = document.createElement("p");
        linksHeading.className = "step-sub";
        linksHeading.textContent = "Read the full text:";
        section.appendChild(linksHeading);

        const linksList = document.createElement("div");
        linksList.className = "terms-links";
        DOCUMENTS.forEach(function (doc) {
            const row = document.createElement("div");
            row.className = "terms-link-row";
            row.appendChild(buildLink(doc));
            linksList.appendChild(row);
        });
        section.appendChild(linksList);

        const consentBox = document.createElement("div");
        consentBox.className = "terms-consent";

        const docList = DOCUMENTS.map(function (d) { return d.label; }).join(", ").replace(/, ([^,]*)$/, ", and $1");

        function buildCheckbox(id, labelText) {
            const wrap = document.createElement("label");
            wrap.className = "terms-checkbox";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.id = id;
            const span = document.createElement("span");
            span.textContent = labelText;
            wrap.appendChild(cb);
            wrap.appendChild(span);
            return { wrap: wrap, input: cb };
        }

        const consent1 = buildCheckbox("terms-consent-docs", "I have read and agree to the " + docList + ".");
        const consent2 = buildCheckbox("terms-consent-age", "I am 18 or older, or I have the authority to bind the entity I represent.");
        consentBox.appendChild(consent1.wrap);
        consentBox.appendChild(consent2.wrap);
        section.appendChild(consentBox);

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.id = "terms-back"; back.type = "button"; back.className = "btn-ghost"; back.textContent = "Back";
        const acceptBtn = document.createElement("button");
        acceptBtn.id = "terms-accept"; acceptBtn.type = "button"; acceptBtn.className = "btn-primary";
        acceptBtn.textContent = "Accept and Continue";
        acceptBtn.disabled = true;
        actions.appendChild(back);
        actions.appendChild(acceptBtn);
        section.appendChild(actions);

        const err = document.createElement("p");
        err.id = "terms-err"; err.className = "step-error"; err.setAttribute("aria-live", "polite");
        section.appendChild(err);

        const footer = document.createElement("p");
        footer.className = "terms-footer";
        footer.textContent = "Acceptance version " + ACCEPTANCE_VERSION + ". Your acceptance will be recorded with a timestamp.";
        section.appendChild(footer);

        root.appendChild(section);

        function updateButton() {
            acceptBtn.disabled = !(consent1.input.checked && consent2.input.checked);
        }
        consent1.input.addEventListener("change", updateButton);
        consent2.input.addEventListener("change", updateButton);

        back.addEventListener("click", function () {
            if (ctx && typeof ctx.onBack === "function") ctx.onBack();
        });

        acceptBtn.addEventListener("click", async function () {
            if (acceptBtn.disabled) return;
            err.textContent = "";
            if (!window.atlas || typeof window.atlas.saveLegalAcceptance !== "function") {
                err.textContent = "Cannot record acceptance (IPC not ready). Please restart setup.";
                return;
            }
            acceptBtn.disabled = true;
            const documents = {};
            DOCUMENTS.forEach(function (d) { documents[d.id] = d.url; });
            const payload = {
                accepted: true,
                acceptedAt: new Date().toISOString(),
                version: ACCEPTANCE_VERSION,
                documents: documents,
                consents: {
                    documents: !!consent1.input.checked,
                    ageOrAuthority: !!consent2.input.checked,
                },
            };
            let res;
            try { res = await window.atlas.saveLegalAcceptance(payload); }
            catch (e) {
                acceptBtn.disabled = false;
                err.textContent = "Save failed: " + (e.message || e);
                return;
            }
            if (!res || !res.success) {
                acceptBtn.disabled = false;
                err.textContent = (res && res.error) || "Save failed.";
                return;
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.terms = { render: render };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render, DOCUMENTS: DOCUMENTS, ACCEPTANCE_VERSION: ACCEPTANCE_VERSION };
    }
})();

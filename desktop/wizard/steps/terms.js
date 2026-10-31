// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Trust step. Per-document clickwrap consent: each canonical legal
// document has its own row with an UNCHECKED checkbox and a "Read full
// document" link that opens the canonical URL via the OS browser
// (util:open-external allowlist enforces https://tryatlasagi.com).
//
// Continue is disabled until every required box is ticked. The audit
// record submitted to setup:save-legal carries the document URLs and
// the age/authority consent flag, so the on-disk evidence proves
// exactly what the user agreed to and at what version.
(function () {
    "use strict";

    const HUB_URL = "https://tryatlasagi.com/legal";
    const DOCUMENTS = [
        {
            id: "terms",
            url: "https://tryatlasagi.com/terms",
            label: "Terms of Service",
            summary: "The contract between you and XAGI Labs — eligibility, license, AI output, fees, liability, and governing law.",
            check_label: "I have read and accept the Terms of Service.",
        },
        {
            id: "privacy",
            url: "https://tryatlasagi.com/privacy",
            label: "Privacy Policy",
            summary: "What we collect, why, how long we keep it, and the controls you have. DPDP Act / GDPR / CCPA-aware.",
            check_label: "I have read and accept the Privacy Policy.",
        },
        {
            id: "acceptableUse",
            url: "https://tryatlasagi.com/acceptable-use",
            label: "Acceptable Use Policy",
            summary: "The non-negotiable rules. What you can't do with Bhai — illegal activity, harm, deception, abuse — and how we enforce them.",
            check_label: "I have read and accept the Acceptable Use Policy.",
        },
        {
            id: "disclaimer",
            url: "https://tryatlasagi.com/disclaimer",
            label: "Disclaimer",
            summary: "What we don't promise. AI-output limits, autonomous-agent risks, and a reminder that nothing here is professional advice.",
            check_label: "I have read and accept the Disclaimer.",
        },
        {
            id: "refund",
            url: "https://tryatlasagi.com/refund",
            label: "Refund & Cancellation",
            summary: "When subscriptions, credit packs, and one-time purchases are eligible for a refund — and how to ask.",
            check_label: "I have read and accept the Refund & Cancellation policy.",
        },
    ];

    function openExternal(url) {
        if (window.bhai && typeof window.bhai.openExternalUrl === "function") {
            window.bhai.openExternalUrl(url).catch(function () { /* no-op */ });
        }
    }

    function buildDocRow(doc) {
        const row = document.createElement("div");
        row.className = "legal-row";
        row.setAttribute("data-doc-id", doc.id);

        const head = document.createElement("label");
        head.className = "legal-row-head";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "checkbox legal-check";
        cb.checked = false; // affirmative consent — user must tick
        cb.setAttribute("data-doc-check", doc.id);

        const labelText = document.createElement("span");
        labelText.className = "legal-row-label";
        labelText.textContent = doc.check_label;

        head.appendChild(cb);
        head.appendChild(labelText);
        row.appendChild(head);

        const summary = document.createElement("p");
        summary.className = "legal-row-summary";
        summary.textContent = doc.summary;
        row.appendChild(summary);

        const readLink = document.createElement("button");
        readLink.type = "button";
        readLink.className = "legal-row-link";
        readLink.textContent = "Read the full " + doc.label + " →";
        readLink.addEventListener("click", function (ev) {
            ev.preventDefault();
            openExternal(doc.url);
        });
        row.appendChild(readLink);

        return { row: row, checkbox: cb };
    }

    function render(root, ctx) {
        const Copy = window.Copy;
        const section = document.createElement("section");
        section.className = "step step-terms";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("terms", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("terms", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("terms", "sub");
        section.appendChild(sub);

        // Hub link — small, above the list, so the user can browse the
        // index page if they want everything in one tab.
        const hubLine = document.createElement("p");
        hubLine.className = "legal-hub-line";
        const hubBtn = document.createElement("button");
        hubBtn.type = "button";
        hubBtn.className = "legal-hub-link";
        hubBtn.textContent = "Open the full Legal Hub →";
        hubBtn.addEventListener("click", function () { openExternal(HUB_URL); });
        hubLine.appendChild(hubBtn);
        section.appendChild(hubLine);

        // Per-document rows.
        const docsWrap = document.createElement("div");
        docsWrap.className = "legal-docs";
        const checkboxes = [];
        DOCUMENTS.forEach(function (doc) {
            const built = buildDocRow(doc);
            docsWrap.appendChild(built.row);
            checkboxes.push({ id: doc.id, el: built.checkbox });
        });
        section.appendChild(docsWrap);

        // Age / authority row — separate confirmation, required.
        const ageRow = document.createElement("div");
        ageRow.className = "legal-row legal-row-age";
        const ageHead = document.createElement("label");
        ageHead.className = "legal-row-head";
        const ageCb = document.createElement("input");
        ageCb.type = "checkbox";
        ageCb.className = "checkbox legal-check";
        ageCb.checked = false;
        ageCb.setAttribute("data-doc-check", "ageOrAuthority");
        const ageText = document.createElement("span");
        ageText.className = "legal-row-label";
        ageText.textContent = "I am at least 18 years old, or I am authorized to accept these terms on behalf of my organization.";
        ageHead.appendChild(ageCb);
        ageHead.appendChild(ageText);
        ageRow.appendChild(ageHead);
        section.appendChild(ageRow);

        // CTA — disabled until all 6 boxes are ticked.
        const actions = document.createElement("div");
        actions.className = "step-actions";
        const grow = document.createElement("div");
        grow.className = "grow";
        const cta = document.createElement("button");
        cta.type = "button";
        cta.className = "btn btn-primary";
        cta.disabled = true;
        cta.innerHTML = Copy.get("terms", "accept") + ' <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        actions.appendChild(grow);
        actions.appendChild(cta);
        section.appendChild(actions);

        const err = document.createElement("p");
        err.className = "step-error";
        err.setAttribute("aria-live", "polite");
        section.appendChild(err);

        function recomputeEnable() {
            const allDocs = checkboxes.every(function (c) { return c.el.checked; });
            const ageOk  = ageCb.checked;
            cta.disabled = !(allDocs && ageOk);
        }
        checkboxes.forEach(function (c) { c.el.addEventListener("change", recomputeEnable); });
        ageCb.addEventListener("change", recomputeEnable);

        cta.addEventListener("click", async function () {
            recomputeEnable();
            if (cta.disabled) return;
            const documents = {};
            DOCUMENTS.forEach(function (d) { documents[d.id] = d.url; });
            const payload = {
                accepted: true,
                version: (window.WizardRouter && window.WizardRouter.CURRENT_ACCEPTANCE_VERSION) || "1.0.0",
                documents: documents,
                consents: {
                    documents: true,
                    ageOrAuthority: ageCb.checked === true,
                },
            };
            if (window.bhai && typeof window.bhai.saveLegalAcceptance === "function") {
                try {
                    const res = await window.bhai.saveLegalAcceptance(payload);
                    if (!res || res.success !== true) {
                        err.textContent = "Couldn't save acceptance: " + ((res && res.error) || "unknown error");
                        return;
                    }
                } catch (e) {
                    err.textContent = "Couldn't save acceptance: " + (e.message || e);
                    return;
                }
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });

        root.appendChild(section);

        return {
            // Exposed for tests + introspection.
            checkboxes: checkboxes,
            ageCheckbox: ageCb,
            cta: cta,
            documents: DOCUMENTS,
            recomputeEnable: recomputeEnable,
        };
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.terms = { render: render, DOCUMENTS: DOCUMENTS, HUB_URL: HUB_URL };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render, DOCUMENTS: DOCUMENTS, HUB_URL: HUB_URL };
    }
})();

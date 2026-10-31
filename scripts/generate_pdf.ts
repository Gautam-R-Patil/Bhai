import { chromium } from 'playwright-core';
import * as path from 'path';
import * as fs from 'fs';

(async () => {
    console.log("Reading readme.md...");
    const markdown = fs.readFileSync(path.resolve(process.cwd(), 'readme.md'), 'utf-8');

    // Escape backticks and backslashes for safe injection
    const safeMarkdown = markdown.replace(/\\/g, '\\\\').replace(/`/g, '\\`');

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.4.0/github-markdown.min.css">
  <style>
    body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 45px; }
    .mermaid { display: flex; justify-content: center; margin: 20px 0; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>
    window.MathJax = {
      tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']], displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']], processEscapes: true },
      startup: { typeset: false }
    };
  </script>
  <script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
</head>
<body class="markdown-body">
  <div id="content"></div>
  <script>
    mermaid.initialize({ startOnLoad: false });
    
    // Static injected markdown
    let text = \`${safeMarkdown}\`;
    
    const mathBlocks = [];
    
    async function renderMarkdown() {
      // Preserve block math $$ ... $$
      text = text.replace(/\\$\\$([\\s\\S]*?)\\$\\$/g, (match, p1) => {
          const id = mathBlocks.length;
          mathBlocks.push('$$' + p1 + '$$');
          return \`MATHBLOCKPLACEHOLDER\${id}ENDMATH\`;
      });
      
      // Preserve inline math $ ... $
      text = text.replace(/\\$([^\\n]*?)\\$/g, (match, p1) => {
          const id = mathBlocks.length;
          mathBlocks.push('$' + p1 + '$');
          return \`MATHBLOCKPLACEHOLDER\${id}ENDMATH\`;
      });

      document.getElementById('content').innerHTML = marked.parse(text);
      
      // Restore math blocks safely
      document.getElementById('content').innerHTML = document.getElementById('content').innerHTML.replace(/MATHBLOCKPLACEHOLDER(\\d+)ENDMATH/g, (match, p1) => {
          return mathBlocks[parseInt(p1)];
      });
      
      // Fix mermaid
      document.querySelectorAll('pre code.language-mermaid').forEach(el => {
        const parent = el.parentElement;
        const newDiv = document.createElement('div');
        newDiv.className = 'mermaid';
        newDiv.textContent = el.textContent;
        newDiv.innerHTML = newDiv.innerHTML.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); 
        parent.replaceWith(newDiv);
      });

      // Render components
      try { await mermaid.run({ querySelector: '.mermaid' }); } catch(e) {}
      try { await MathJax.typesetPromise(); } catch(e) {}
      
      window.allDone = true;
    }
    
    // Give external scripts 100ms to load before triggering render
    setTimeout(renderMarkdown, 100);
  </script>
</body>
</html>
  `;

    const finalHtmlPath = path.resolve(process.cwd(), 'scripts/final_render.html');
    fs.writeFileSync(finalHtmlPath, htmlContent);

    console.log("Launching headless browser to compile PDF...");
    const browser = await chromium.launch({ headless: true, args: ['--disable-web-security'] });
    const page = await browser.newPage();

    await page.goto('file://' + finalHtmlPath, { waitUntil: 'networkidle' });

    console.log("Waiting for MathJax/Mermaid to finish rendering...");
    try {
        await page.waitForFunction(() => (window as any).allDone === true, undefined, { timeout: 15000 });
        console.log("Rendering complete on DOM!");
    } catch (e) {
        console.warn("Wait timed out, proceeding anyway.");
    }

    // Wait an extra second for fonts/mathjax to paint cleanly
    await page.waitForTimeout(1000);

    await page.pdf({
        path: path.resolve(process.cwd(), 'readme.pdf'),
        format: 'A4',
        printBackground: true,
        margin: { top: '30px', bottom: '30px', left: '30px', right: '30px' }
    });

    await browser.close();
    console.log("✅ PDF Generated successfully!");
})();

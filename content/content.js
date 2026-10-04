(() => {
  if (window.__lightNovelReaderLoaded) return;
  window.__lightNovelReaderLoaded = true;

  const NOISE_SELECTORS = [
    "script", "style", "noscript", "template", "nav", "header", "footer",
    "aside", "form", "button", "input", "textarea", "select",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    ".comments", ".comment", ".comments-area", ".sidebar", ".advertisement",
    ".ads", ".ad", ".social", ".share"
  ];

  function cleanText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function score(element) {
    const text = cleanText(element.innerText || "");
    if (text.length < 300) return -Infinity;
    const paragraphs = element.querySelectorAll("p").length;
    const sentences = (text.match(/[.!?]["'”’)]?(?=\s|$)/g) || []).length;
    const links = element.querySelectorAll("a").length;
    return text.length + paragraphs * 250 + sentences * 25 - links * 100;
  }

  function extract() {
    const candidates = [
      document.querySelector("article"),
      document.querySelector("[role='main']"),
      document.querySelector("main"),
      document.querySelector(".chapter"),
      document.querySelector(".chapter-content"),
      document.querySelector(".entry-content"),
      document.querySelector(".post-content"),
      document.querySelector(".reading-content"),
      document.body
    ].filter(Boolean);

    const best = candidates.sort((a, b) => score(b) - score(a))[0];
    if (!best) return { title: document.title, text: "" };

    const clone = best.cloneNode(true);
    for (const selector of NOISE_SELECTORS) {
      clone.querySelectorAll(selector).forEach((node) => node.remove());
    }

    const paragraphs = [...clone.querySelectorAll("p")]
      .map((p) => cleanText(p.innerText || ""))
      .filter((text) => text.length >= 2);

    let text = paragraphs.join("\n\n");
    if (text.length < 300) text = cleanText(clone.innerText || "");

    return { title: document.title.trim(), url: location.href, text };
  }

  function chunkText(text) {
    return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "EXTRACT_PAGE") {
      const result = extract();
      return Promise.resolve({ ...result, chunks: chunkText(result.text) });
    }
  });
})();







const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RAW_TAGS = new Set(["script", "style", "textarea", "title"]);

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
};

function decodeEntities(s) {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] !== undefined ? ENTITIES[body] : m;
  });
}

function parseAttrs(str) {
  const attrs = new Map();
  const re =
    /([a-zA-Z0-9_:@.\-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(str)) !== null)
    attrs.set(
      m[1].toLowerCase(),
      m[2] !== undefined
        ? m[2]
        : m[3] !== undefined
          ? m[3]
          : m[4] !== undefined
            ? m[4]
            : "",
    );
  return attrs;
}

function makeElement(tagName, attrsStr) {
  const el = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attrs: attrsStr ? parseAttrs(attrsStr) : new Map(),
    children: [],
    textNodes: [],
    parent: null,
    append(child) {
      child.parent = this;
      this.children.push(child);
    },
    get textContent() {
      let out = "";
      for (const t of this.textNodes) out += t.data;
      for (const c of this.children) out += c.textContent;
      return out;
    },
    get innerHTML() {
      let out = "";
      for (const t of this.textNodes) out += t.data;
      for (const c of this.children) out += c.outerHTML;
      return out;
    },
    get outerHTML() {
      const name = this.tagName.toLowerCase();
      let attrs = "";
      for (const [k, v] of this.attrs)
        attrs += v === "" ? ` ${k}` : ` ${k}="${v.replace(/"/g, "&quot;")}"`;
      if (VOID_TAGS.has(name)) return `<${name}${attrs}>`;
      return `<${name}${attrs}>${this.innerHTML}</${name}>`;
    },
    get className() {
      return this.attrs.get("class") || "";
    },
    get id() {
      return this.attrs.get("id") || "";
    },
    getAttribute(name) {
      return this.attrs.get(String(name).toLowerCase()) ?? null;
    },
    get parentElement() {
      return this.parent;
    },
    get nextElementSibling() {
      if (!this.parent) return null;
      const i = this.parent.children.indexOf(this);
      return this.parent.children[i + 1] || null;
    },
    get previousElementSibling() {
      if (!this.parent) return null;
      const i = this.parent.children.indexOf(this);
      return i > 0 ? this.parent.children[i - 1] : null;
    },
    get firstElementChild() {
      return this.children[0] || null;
    },
    get lastElementChild() {
      return this.children[this.children.length - 1] || null;
    },
    matches(sel) {
      return matchesSelector(this, sel);
    },
    querySelector(sel) {
      return selectAll(this, sel)[0] || null;
    },
    querySelectorAll(sel) {
      return selectAll(this, sel);
    },
  };
  return el;
}



function splitTopLevel(str, sep) {
  const out = [];
  let depth = 0,
    quote = null,
    cur = "";
  for (const ch of str) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth--;
      cur += ch;
    } else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseSimple(sel) {
  const s = sel.trim();
  const out = { tag: null, id: null, classes: [], contains: null };
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === "*") {
      i++;
      continue;
    }
    if (ch === "#") {
      const m = /^#([\w\-]+)/.exec(s.slice(i));
      if (m) {
        out.id = m[1];
        i += m[0].length;
        continue;
      }
    }
    if (ch === ".") {
      const m = /^\.([\w\-]+)/.exec(s.slice(i));
      if (m) {
        out.classes.push(m[1]);
        i += m[0].length;
        continue;
      }
    }
    if (ch === ":") {
      const m = /^:contains\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/.exec(
        s.slice(i),
      );
      if (m) {
        out.contains =
          m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
        i += m[0].length;
        continue;
      }
    }
    if (/[a-zA-Z]/.test(ch)) {
      const m = /^([a-zA-Z][\w\-]*)/.exec(s.slice(i));
      if (m) {
        out.tag = m[1].toLowerCase();
        i += m[0].length;
        continue;
      }
    }
    i++; 
  }
  return out;
}

function parseSelector(sel) {
  return splitTopLevel(sel, ",").map((alt) => {
    const parts = [];
    let i = 0;
    const s = alt.trim();
    while (i < s.length) {
      let comb = " ";
      if (s[i] === ">") {
        comb = ">";
        i++;
        while (i < s.length && s[i] === " ") i++;
      } else if (s[i] === " ") {
        while (i < s.length && s[i] === " ") i++;
      }
      const start = i;
      let depth = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if ((ch === " " || ch === ">") && depth === 0) break;
        i++;
      }
      if (i === start) {
        i++;
        continue;
      }
      parts.push([comb, parseSimple(s.slice(start, i))]);
    }
    return parts;
  });
}

function matchSimple(el, simple) {
  if (simple.tag && el.tagName.toLowerCase() !== simple.tag) return false;
  if (simple.id && el.id !== simple.id) return false;
  if (simple.classes.length) {
    const cls = el.className.split(/\s+/).filter(Boolean);
    for (const c of simple.classes) if (cls.indexOf(c) === -1) return false;
  }
  if (
    simple.contains !== null &&
    el.textContent.toLowerCase().indexOf(simple.contains.toLowerCase()) === -1
  )
    return false;
  return true;
}




function matchesReverse(el, parts, idx) {
  if (!matchSimple(el, parts[idx][1])) return false;
  if (idx === 0) return true;
  const comb = parts[idx][0];
  if (comb === ">")
    return el.parentElement
      ? matchesReverse(el.parentElement, parts, idx - 1)
      : false;
  for (let a = el.parentElement; a; a = a.parentElement) {
    if (matchesReverse(a, parts, idx - 1)) return true;
  }
  return false;
}

function descendants(el) {
  const out = [];
  const walk = (node) => {
    for (const c of node.children) {
      out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

function matchesSelector(el, sel) {
  const alts = parseSelector(sel);
  return alts.some(
    (parts) => parts.length > 0 && matchesReverse(el, parts, parts.length - 1),
  );
}

function selectAll(root, sel) {
  const alts = parseSelector(sel);
  const all = [root, ...descendants(root)];
  return all.filter((el) =>
    alts.some(
      (parts) =>
        parts.length > 0 && matchesReverse(el, parts, parts.length - 1),
    ),
  );
}



function parseHtml(html) {
  const root = makeElement("body", "");
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const len = String(html).length;
  while (i < len) {
    const lt = String(html).indexOf("<", i);
    if (lt === -1) {
      const t = decodeEntities(String(html).slice(i));
      if (t) top().textNodes.push({ data: t });
      break;
    }
    if (lt > i) {
      const t = decodeEntities(String(html).slice(i, lt));
      if (t) top().textNodes.push({ data: t });
    }
    const rest = String(html).slice(lt);
    if (rest.startsWith("<!--")) {
      const end = String(html).indexOf("-->", lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (rest.startsWith("<!") || rest.startsWith("<?")) {
      const end = String(html).indexOf(">", lt);
      i = end === -1 ? len : end + 1;
      continue;
    }
    if (rest.startsWith("</")) {
      const m = /^<\/\s*([a-zA-Z0-9\-]+)\s*>/.exec(rest);
      if (m) {
        const name = m[1].toLowerCase();
        for (let s = stack.length - 1; s >= 1; s--) {
          if (stack[s].tagName.toLowerCase() === name) {
            stack.length = s;
            break;
          }
        }
        i = lt + m[0].length;
      } else {
        i = lt + 1;
      }
      continue;
    }
    const tagM = /^<([a-zA-Z0-9\-]+)((?:\s+[^<>]*?)?)(\/?)>/.exec(rest);
    if (!tagM) {
      i = lt + 1;
      continue;
    }
    const name = tagM[1].toLowerCase();
    const el = makeElement(name, tagM[2]);
    top().append(el);
    i = lt + tagM[0].length;
    if (VOID_TAGS.has(name) || tagM[3] === "/") continue;
    if (RAW_TAGS.has(name)) {
      const end = String(html).indexOf("</" + name, i);
      if (end === -1) {
        const t = String(html).slice(i);
        if (t) el.textNodes.push({ data: t });
        i = len;
      } else {
        const t = String(html).slice(i, end);
        if (t) el.textNodes.push({ data: t });
        i = end;
        for (let s = stack.length - 1; s >= 1; s--) {
          if (stack[s].tagName.toLowerCase() === name) {
            stack.length = s;
            break;
          }
        }
      }
      continue;
    }
    stack.push(el);
  }
  return root;
}

function parse_html(html, selector, attr) {
  const doc = parseHtml(html);
  return doc.querySelectorAll(selector).map((el) => ({
    text: el.textContent.trim(),
    html: el.innerHTML,
    attr: attr ? el.getAttribute(attr) : null,
    src: el.getAttribute("src"),
    href: el.getAttribute("href"),
  }));
}


function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unpackJs(js) {
  const m =
    /^\s*eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*(?:,\s*d)?\s*\)\s*\{[\s\S]*?\}\s*\(\s*([\s\S]*?)\)\s*\)\s*;?\s*$/.exec(
      js,
    );
  if (!m) return js;
  const args = splitTopLevel(m[1], ",");
  if (args.length < 5) return js;
  const pRaw = args[0].trim();
  const pm = /^(['"])([\s\S]*)\1$/.exec(pRaw);
  const p = pm ? pm[2] : pRaw;
  const c = parseInt(args[2], 10) || 0;
  
  const km = /^'((?:[^'\\]|\\.)*)'\.split\('\|'\)$/.exec(args[3].trim());
  const k = km ? km[1].split("|") : String(args[3] || "").split("|");
  const hasD = args.length >= 6;
  const unescapeStr = hasD
    ? (s) =>
        s
          .replace(/\\'/g, "'")
          .replace(/\\\\/g, "\\")
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
    : (s) => s;
  let s = unescapeStr(p);
  
  for (let i = c - 1; i >= 0; i--) {
    const token = i.toString(36);
    const word = k[i];
    if (word)
      s = s.replace(new RegExp("\\b" + escapeRegExp(token) + "\\b", "g"), word);
  }
  return s;
}

module.exports = { parseHtml, parse_html, unpackJs };

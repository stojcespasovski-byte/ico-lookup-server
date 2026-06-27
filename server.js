const http = require("http");
const https = require("https");

const PRAVNA_FORMA_CZ = {"101":"v.o.s.","102":"k.s.","111":"s.r.o.","112":"s.r.o.","121":"a.s.","141":"družstvo","145":"bytové družstvo","151":"štátny podnik","205":"živnostník","325":"nadácia","331":"občianske združenie"};

function get(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*" }, timeout: 8000 }, (res) => {
      if ([301,302,303].includes(res.statusCode) && res.headers.location) return resolve(get(res.headers.location));
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function strip(s) { return s.replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim(); }
function win1250(buf) { try { return new TextDecoder("windows-1250").decode(buf); } catch(e) { return buf.toString("latin1"); } }

async function lookupCZ(ico) {
  const r = await get(`https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${ico}`);
  if (r.status !== 200) return null;
  const d = JSON.parse(r.body.toString());
  const s = d.sidlo || {};
  const ulica = s.nazevUlice || "";
  const cislo = [s.cisloDomovni, s.cisloOrientacni].filter(Boolean).join("/");
  return { nazov: d.obchodniJmeno||"", ulica, cislo, mesto: s.nazevObce||"", psc: s.psc?String(s.psc).replace(/(\d{3})(\d{2})/,"$1 $2"):"", stat:"CZ", pravna_forma: PRAVNA_FORMA_CZ[d.pravniForma]||d.pravniForma||"", konatelia:[], error:null };
}

async function lookupSK(ico) {
  const r = await get(`https://www.orsr.sk/hladaj_ico.asp?ICO=${ico}&SID=0`);
  const html = win1250(r.body);
  const link = html.match(/href="(vypis\.asp\?[^"]+)"/i);
  if (!link) return null;
  let detailUrl = "https://www.orsr.sk/" + link[1].replace(/&amp;/g,"&");
  if (!detailUrl.includes("P=1")) detailUrl = detailUrl.replace(/P=0/,"P=1");
  const r2 = await get(detailUrl);
  const h = win1250(r2.body);
  const tds = [...h.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => strip(m[1]));

  function getAfter(label) {
    const idx = tds.findIndex(t => t.toLowerCase().includes(label.toLowerCase()));
    if (idx === -1) return "";
    for (let i = idx+1; i < Math.min(idx+5, tds.length); i++) {
      const v = tds[i].trim();
      if (v && !v.startsWith("(od:") && v !== "&") return v;
    }
    return "";
  }

  const nazov = getAfter("Obchodné meno:");
  const sidloRaw = getAfter("Sídlo:");
  const pravna_forma = getAfter("Právna forma:");

  const pscMatch = sidloRaw.match(/(\d{3}\s?\d{2})\s*$/);
  const psc = pscMatch ? pscMatch[1].replace(/\s/g,"") : "";
  const withoutPsc = sidloRaw.replace(/\s*\d{3}\s?\d{2}\s*$/,"").replace(/\s*-\s*mestská\s*časť\s+\S+/i,"").trim();
  const streetMatch = withoutPsc.match(/^(.+?\d+[/\w]*)\s+(.+)$/);
  const addrPart = streetMatch ? streetMatch[1] : withoutPsc;
  const mesto = streetMatch ? streetMatch[2].trim() : "";
  const cisloMatch = addrPart.match(/^(.+?)\s+(\d+[/\w]*)$/);
  const ulica = cisloMatch ? cisloMatch[1].trim() : addrPart;
  const cislo = cisloMatch ? cisloMatch[2].trim() : "";

  const konatelia = [];
  const statIdx = tds.findIndex(t => t.includes("Štatutárny orgán:"));
  const konecIdx = tds.findIndex(t => t.includes("Konanie menom"));
  if (statIdx !== -1) {
    const end = konecIdx !== -1 ? konecIdx : statIdx + 30;
    for (let i = statIdx + 1; i < end; i++) {
      const td = tds[i];
      if (!td) continue;
      if (td.startsWith("(od:") || td === "konateľ" || td.includes("Štatutárny") || td.includes("Konanie")) continue;
      if (!td.match(/\d{3}\s?\d{2}/)) continue;
      const nextTd = tds[i+1] || "";
      if (nextTd.includes("do:")) continue;
      const clean = td.replace(/\s*Vznik funkcie.*$/i,"").trim();
      const tokens = clean.split(/\s+/);
      let houseIdx = -1;
      for (let j = 1; j < tokens.length; j++) {
        if (tokens[j].match(/^\d+[/\w]*$/) && !tokens[j].match(/^\d{3}$/)) { houseIdx = j; break; }
      }
      if (houseIdx === -1) continue;
      const meno = tokens.slice(0, houseIdx-1).join(" ").trim();
      const kUlica = tokens[houseIdx-1];
      const kCislo = tokens[houseIdx];
      const rest = tokens.slice(houseIdx + 1);
      let kPsc = "";
      if (rest.length >= 2 && rest[rest.length-1].match(/^\d{2}$/) && rest[rest.length-2].match(/^\d{3}$/)) {
        kPsc = rest[rest.length-2] + rest[rest.length-1]; rest.splice(-2);
      } else if (rest.length >= 1 && rest[rest.length-1].match(/^\d{5}$/)) {
        kPsc = rest.pop();
      }
      const kObec = rest.join(" ").replace(/\s*-\s*mestská\s*časť\s+\S+/i,"").trim();
      if (meno) konatelia.push({ meno, ulica: kUlica, cislo: kCislo, obec: kObec, psc: kPsc });
    }
  }

  return { nazov, ulica, cislo, mesto, psc, stat:"SK", pravna_forma, konatelia, error:null };
}

const PORT = process.env.PORT || 3001;
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Content-Type","application/json; charset=utf-8");
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const match = url.pathname.match(/^\/ico\/(\d+)/);
  if (!match) return res.end(JSON.stringify({error:"Použite /ico/CISLO"}));
  const ico = match[1];
  const stat = url.searchParams.get("stat");
  console.log(`[${new Date().toLocaleTimeString()}] IČO: ${ico} | ${stat}`);
  if (stat === "CZ") {
    try { const d = await lookupCZ(ico); if (d) { console.log("  → CZ:", d.nazov); return res.end(JSON.stringify(d)); } } catch(e) { console.log("  CZ:", e.message); }
    return res.end(JSON.stringify({error:"Firma nebola nájdená v českom registri."}));
  }
  if (stat === "SK") {
    try { const d = await lookupSK(ico); if (d&&d.nazov) { console.log("  → SK:", d.nazov); return res.end(JSON.stringify(d)); } } catch(e) { console.log("  SK:", e.message); }
    return res.end(JSON.stringify({error:"Firma nebola nájdená v slovenskom registri."}));
  }
  res.end(JSON.stringify({error:"Chýba parameter stat=SK alebo stat=CZ"}));
});

server.listen(PORT, () => console.log(`✓ Server beží na porte ${PORT}`));

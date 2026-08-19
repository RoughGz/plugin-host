
const { promises: dns } = require("node:dns");

function isPrivateIp(ip) {
  if (/^::ffff:/i.test(ip)) return true; 
  if (ip === "0.0.0.0" || ip === "::" || ip === "::1") return true;
  if (/^::\d+\./.test(ip)) return true; 
  if (/^64:ff9b:/i.test(ip)) return true; 
  if (/^2002:/i.test(ip)) return true; 
  if (/^2001:0:/i.test(ip)) return true; 
  if (/^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip))
    return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true; 
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true; 
  if (/^198\.(18|19)\./.test(ip)) return true; 
  if (/^192\.0\.0\./.test(ip) || /^192\.0\.2\./.test(ip)) return true;
  if (/^198\.51\.100\./.test(ip) || /^203\.0\.113\./.test(ip)) return true;
  if (/^fe80:/i.test(ip) || /^f[cd]/i.test(ip)) return true;
  return false;
}

async function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, ""); 
  if (h === "localhost" || h.endsWith(".local")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return isPrivateIp(h);
  try {
    
    const addrs = await dns.lookup(h, { all: true });
    return addrs.some((a) => isPrivateIp(a.address));
  } catch (e) {
    return true; 
  }
}

module.exports = { isPrivateIp, isPrivateHost };

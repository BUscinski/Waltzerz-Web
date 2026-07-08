const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid 1/0 confusion
const activeCodes = new Set();

function generateCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join("");
  } while (activeCodes.has(code));
  activeCodes.add(code);
  return code;
}

function releaseCode(code) {
  activeCodes.delete(code);
}

module.exports = { generateCode, releaseCode };

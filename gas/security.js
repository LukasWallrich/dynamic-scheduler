/**
 * security.js — tokens, hashing, the setup bootstrap token.
 * 128-bit+ random tokens; only SHA-256 hashes are persisted for auth. Possession of a
 * token is authorization; the JSON API needs no per-request nonce (every write is a POST).
 */

var Security = {

  /** New high-entropy token (256 bits via two UUIDs, hex-ish). */
  newToken: function () {
    return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  },

  /** SHA-256 hex of a token — the only form stored for verification. */
  hashToken: function (token) {
    var bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = (bytes[i] + 256) % 256;
      hex += (b < 16 ? '0' : '') + b.toString(16);
    }
    return hex;
  },

  /** Constant-ish-time equality on hex strings. */
  hashEquals: function (a, b) {
    if (!a || !b || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  },

  /** Setup bootstrap token, minted once and kept in Script Properties. */
  setupToken: function () {
    var props = PropertiesService.getScriptProperties();
    var t = props.getProperty('SETUP_TOKEN');
    if (!t) { t = this.newToken(); props.setProperty('SETUP_TOKEN', t); }
    return t;
  }
};

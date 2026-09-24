// Bounded, session-only account metadata. Passwords are never retained here.
export class AccountCache {
  constructor({ ttl = 60000, limit = 128, now = Date.now } = {}) {
    this.ttl = ttl; this.limit = limit; this.now = now; this.values = new Map();
  }
  get(host) {
    const entry = this.values.get(host);
    if (!entry || this.now() >= entry.expires) { this.values.delete(host); return null; }
    return entry.accounts.map(account => ({...account}));
  }
  set(host, accounts) {
    this.values.delete(host);
    this.values.set(host, {expires:this.now()+this.ttl, accounts:accounts.map(({username,label}) => ({username,label}))});
    while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value);
  }
  clear() { this.values.clear(); }
}

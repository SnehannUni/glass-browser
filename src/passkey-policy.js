// Glass owns the inline account picker. Explicit WebAuthn sign-in remains native.
(() => {
  if (location.protocol !== 'https:' || !window.PublicKeyCredential || !navigator.credentials) return;
  const credential = window.PublicKeyCredential;
  if (credential.isConditionalMediationAvailable) credential.isConditionalMediationAvailable = async () => false;
  if (credential.getClientCapabilities) {
    const capabilities = credential.getClientCapabilities.bind(credential);
    credential.getClientCapabilities = async () => ({...await capabilities(), conditionalGet: false});
  }
  const get = navigator.credentials.get;
  navigator.credentials.get = function(options) {
    if (options?.publicKey && options.mediation === 'conditional') {
      return Promise.reject(new DOMException('Inline passkey suggestions are disabled in Glass.', 'NotSupportedError'));
    }
    return Reflect.apply(get, this, arguments);
  };
})();

function get(keys){return new Promise(r=>chrome.storage.sync.get(keys,r));}
function set(obj){return new Promise(r=>chrome.storage.sync.set(obj,r));}

(async function init(){
  const modeEl = document.getElementById('mode');
  const apiFieldsEl = document.getElementById('apiFields');
  const clientIdEl = document.getElementById('clientId');
  const privacyEl = document.getElementById('privacy');
  const redirEl = document.getElementById('redir');
  const saveBtn = document.getElementById('save');

  redirEl.textContent = chrome.identity.getRedirectURL('oauth2');

  // Client ID and privacy only matter in api mode; dim rather than hide so the
  // values stay visible and editable.
  const syncDim = ()=> apiFieldsEl.classList.toggle('dimmed', modeEl.value !== 'api');

  const { mode, googleClientId, privacy } = await get([ 'mode', 'googleClientId', 'privacy' ]);
  modeEl.value = mode === 'api' ? 'api' : 'free'; // unset = free
  if (googleClientId) clientIdEl.value = googleClientId;
  if (privacy) privacyEl.value = privacy;
  syncDim();
  modeEl.addEventListener('change', syncDim);

  saveBtn.addEventListener('click', async () => {
    const mode = modeEl.value;
    const googleClientId = clientIdEl.value.trim();
    const privacy = privacyEl.value;
    await set({ mode, googleClientId, privacy });
    saveBtn.textContent = 'Saved!';
    setTimeout(()=> saveBtn.textContent='Save', 1200);
  });
})();

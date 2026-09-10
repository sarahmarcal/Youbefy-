function get(keys){return new Promise(r=>chrome.storage.sync.get(keys,r));}
function set(obj){return new Promise(r=>chrome.storage.sync.set(obj,r));}

(async function init(){
  const clientIdEl = document.getElementById('clientId');
  const privacyEl = document.getElementById('privacy');
  const redirEl = document.getElementById('redir');
  const saveBtn = document.getElementById('save');

  redirEl.textContent = chrome.identity.getRedirectURL('oauth2');

  const { googleClientId, privacy } = await get([ 'googleClientId', 'privacy' ]);
  if (googleClientId) clientIdEl.value = googleClientId;
  if (privacy) privacyEl.value = privacy;

  saveBtn.addEventListener('click', async () => {
    const googleClientId = clientIdEl.value.trim();
    const privacy = privacyEl.value;
    await set({ googleClientId, privacy });
    saveBtn.textContent = 'Saved!';
    setTimeout(()=> saveBtn.textContent='Save', 1200);
  });
})();

// The app's settings page inside the Zepp phone app: paste the same setup
// link/code the phone web app uses. Stored in settingsStorage, which the side
// service reads.

import { parseSetup } from '../lib/setup.js';

const host = (url) => (/^https?:\/\/([^/]+)/.exec(url) || [])[1] || url;

AppSettingsPage({
  state: { error: '' },
  build(props) {
    const storage = props.settingsStorage;
    const cfg = parseSetup(storage.getItem('setup'));
    const status = cfg
      ? `Connected to ${host(cfg.url)}${cfg.name ? ` (${cfg.name})` : ''}.`
      : 'Not set up yet.';
    return View({ style: { padding: '16px 20px' } }, [
      Text({ bold: true, paragraph: true, style: { fontSize: '20px' } }, '5/3/1 watch'),
      Text({ paragraph: true, style: { color: cfg ? '#1f8f3a' : '#b33' } }, status),
      TextInput({
        label: cfg ? 'Replace setup link or code' : 'Paste the setup link or code',
        placeholder: 'https://…#setup=…',
        value: '',
        subStyle: { fontSize: '14px' },
        onChange: (val) => {
          if (parseSetup(val)) {
            this.state.error = '';
            storage.setItem('setup', String(val).trim());
          } else {
            this.state.error = 'That is not a setup link or code.';
            storage.setItem('setupError', String(Date.now()));
          }
        },
      }),
      this.state.error ? Text({ paragraph: true, style: { color: '#b33' } }, this.state.error) : null,
      cfg
        ? Button({
            label: 'Disconnect',
            style: { marginTop: '12px', fontSize: '14px', borderRadius: '20px', background: '#8a2525', color: 'white' },
            onClick: () => storage.removeItem('setup'),
          })
        : null,
      Text({ paragraph: true, style: { marginTop: '16px', fontSize: '13px', color: '#666' } },
        'Use the setup link you opened the phone app with, or the code printed by `npm run backend:test:link` / the dev server page. ' +
        'Keep the Zepp app allowed to run in the background (no battery optimisation) so the watch can sync.'),
    ].filter(Boolean));
  },
});

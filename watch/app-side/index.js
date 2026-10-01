// Runs inside the Zepp app on the phone. The watch asks it for today's plan
// ("package") and to sync; it forwards to the Apps Script backend using the
// setup code pasted in this app's settings (see setting/index.js).

import { BaseSideService, settingsLib } from '@zeppos/zml/base-side';
import { handle, parseSetup } from '../lib/side.js';

AppSideService(
  BaseSideService({
    onInit() {},
    onRequest(req, res) {
      const cfg = parseSetup(settingsLib.getItem('setup'));
      handle(req.method, req.params, { fetchFn: (opts) => fetch(opts), cfg })
        .then((data) => res(null, data))
        .catch((e) => {
          console.log(`${req.method} failed: ${e && e.message}`);
          res({ message: String((e && e.message) || e) });
        });
    },
    onRun() {},
    onDestroy() {},
  }),
);

import { render } from 'preact';
import { App } from './app.tsx';
import { consumeSetupLink, getConfig } from './api.ts';
import './style.css';

consumeSetupLink();
const env = getConfig()?.name;
render(<>{env && <div class="env-badge">{env}</div>}<App /></>, document.getElementById('app')!);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./sw.js');
}

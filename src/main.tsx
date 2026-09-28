import { render } from 'preact';
import { App } from './app.tsx';
import { consumeSetupLink } from './api.ts';
import './style.css';

consumeSetupLink();
render(<App />, document.getElementById('app')!);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./sw.js');
}

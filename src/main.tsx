import { render } from 'preact';
import { App } from './app.tsx';
import { consumeSetupLink } from './api.ts';
import './style.css';

consumeSetupLink();
render(<App />, document.getElementById('app')!);

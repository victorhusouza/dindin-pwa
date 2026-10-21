import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Gate } from './gate';
import './style.css';

createRoot(document.getElementById('root')!).render(<Gate><App /></Gate>);

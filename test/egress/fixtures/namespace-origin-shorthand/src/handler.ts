import * as api from './octo/api.js';
const alias: any = api;
const holder = { alias };
const { alias: { sendMessage } } = holder;
sendMessage();

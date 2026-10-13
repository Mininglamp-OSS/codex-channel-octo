import * as api from './octo/api.js';
let holder: any;
holder = { ...holder, ...api };
const { sendMessage } = holder;
sendMessage();

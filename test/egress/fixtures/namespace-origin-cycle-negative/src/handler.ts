let holder: any;
holder = { ...holder, read() {} };
const { read } = holder;
read();

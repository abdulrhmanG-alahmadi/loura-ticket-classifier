/** The worker and error hook log on purpose; keep test output to the test reporter. */
console.log = console.warn = console.error = () => {};

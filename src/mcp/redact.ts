// What goes to the local log about an unexpected error: its message, with absolute paths
// replaced, so a log line names no directory or user.

const PATH = /(^|[\s'"(=:,])(?:[A-Za-z]:)?[\\/][^\s'"`),]+/g;

export const redact = (message: string): string =>
  message.replace(PATH, "$1<path>").slice(0, 300);

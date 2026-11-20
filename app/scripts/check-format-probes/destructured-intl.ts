// Intl's formatters pulled out by destructuring, and a toLocale* method the same way.
const { DateTimeFormat } = Intl
const { toLocaleDateString } = Date.prototype
export const a = new DateTimeFormat('en-US').format(0)
export const b = toLocaleDateString.call(new Date())

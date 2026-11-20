// toLocale* through bracket access, with a string and with a template literal.
export const a = new Date()['toLocaleString']()
export const b = (1234).toLocaleString === undefined ? '' : (1234)[`toLocaleString`]()

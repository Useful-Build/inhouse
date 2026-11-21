// `//` inside a string, then a call on the same line: the old scan blanked the rest of the line as a comment.
export const a = 'a//b' + new Date().toLocaleTimeString()

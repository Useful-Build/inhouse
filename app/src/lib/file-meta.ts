// What a file chip says about a file: its size line and its icon.
export const fileSize = (b: number) => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'
export const fileIcon = (n: string) => /\.(png|jpe?g|gif|webp|heic)$/i.test(n) ? 'image' : /\.(csv|xlsx?|numbers)$/i.test(n) ? 'table_view' : /\.pdf$/i.test(n) ? 'picture_as_pdf' : 'description'

// Static assets are served before the Worker runs, so anything that reaches it has no route yet.
export default {
  fetch() {
    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>

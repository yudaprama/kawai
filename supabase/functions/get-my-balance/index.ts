// get-my-balance — Edge Function untuk user membaca saldo sendiri.
// Auth: JWT Supabase user (verify_jwt=true). RPC-nya memverifikasi
// auth.uid() di sisi DB, jadi function ini benar-benar tipis.

const headers = { "Content-Type": "application/json" };

Deno.serve(async (req: Request) => {
  // JWT user diverifikasi otomatis oleh platform (verify_jwt);
  // header Authorization: Bearer <access_token> diteruskan ke PostgREST,
  // sehingga auth.uid() di dalam RPC terisi benar.
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const rpc = await fetch(`${supabaseUrl}/rest/v1/rpc/get_my_balance`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: auth, // JWT user diteruskan apa adanya
    },
    body: JSON.stringify({}),
  });

  return new Response(await rpc.text(), { status: rpc.status, headers });
});

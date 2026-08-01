import { useQuery } from "gemi/client";

/**
 * `Query.prefetch("/suspense-demo/products")` runs in this view's handler, so
 * despite the endpoint's 600ms delay neither card ever hits `/api`: on a hard
 * load the shell streams immediately and the products section (data included)
 * streams in when the query lands ~600ms later; on a client-side navigation
 * the data arrives in the route payload.
 */
export default function SuspenseDemoInstant() {
  return (
    <div>
      <p className="text-sm text-slate-600">
        This page's handler prefetches the query on the server. The endpoint
        takes 600ms — the request starts the moment the route is handled, and
        the browser never makes it.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ProductsCard label="first reader" />
        <ProductsCard label="second reader" />
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Both cards read the same query. The shared <strong>call #</strong>{" "}
        shows one request served both — reads on the same path and variant are
        deduped, whether they come from prefetch, suspension, or both.
      </p>
    </div>
  );
}

function ProductsCard(props: { label: string }) {
  // Suspense is the default: `data` is non-nullable, no loading branch.
  const { data } = useQuery("/suspense-demo/products");

  return (
    <section className="rounded-lg border border-emerald-300 bg-emerald-50/50 p-4">
      <header className="flex items-baseline justify-between">
        <h2 className="font-semibold">Products</h2>
        <span className="text-xs uppercase tracking-wide text-slate-500">{props.label}</span>
      </header>
      <ul className="mt-3 space-y-1 text-sm">
        {data.products.map((product) => (
          <li key={product.id} className="flex justify-between">
            <span>{product.name}</span>
            <span className="font-mono">{product.price}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 font-mono text-xs text-slate-500">
        call #{data.call} · {data.at}
      </p>
    </section>
  );
}

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Bulk Price Editor</h1>
        <p className={styles.text}>
          Bulk-edit product prices by collection, tag, vendor, or CSV upload —
          with scheduling and one-click revert.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Bulk rules</strong>. Percent, fixed-amount, or set-value
            price changes by collection, tag, vendor, or product type.
          </li>
          <li>
            <strong>CSV upload</strong>. Apply explicit per-variant prices in
            one batch.
          </li>
          <li>
            <strong>Schedule &amp; revert</strong>. Queue a price change for
            later, auto-revert at a future date, or undo any completed job.
          </li>
        </ul>
      </div>
    </div>
  );
}

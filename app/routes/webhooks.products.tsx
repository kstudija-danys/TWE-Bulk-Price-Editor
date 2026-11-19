import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { queueProductCheck } from "../lib/productWebhooks.server";

// products/create and products/update: lets jobs set to "apply to products
// that match later" pick up new or newly tagged products within seconds.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const productId =
    (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id ??
    ((payload as { id?: number }).id ? `gid://shopify/Product/${(payload as { id: number }).id}` : null);

  if (productId) {
    queueProductCheck(shop, productId);
  } else {
    console.warn(`[webhooks] ${topic} for ${shop} had no product id`);
  }

  // Answer straight away; the check runs in the background.
  return new Response();
};

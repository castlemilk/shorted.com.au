import { permanentRedirect } from "next/navigation";

// The address-level drops board now lives inside the flagship /price-drops
// view (drops by state, suburb, address and agency). Permanent redirect keeps
// old links and any indexed URLs working.
export default function AddressDropsPage() {
  permanentRedirect("/price-drops");
}

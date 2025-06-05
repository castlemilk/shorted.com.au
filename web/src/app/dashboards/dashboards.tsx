import { auth } from "~/server/auth";

export default async function Dashboards() {
  const session = await auth()
  return <pre>{JSON.stringify(session, null, 2)}</pre>
}
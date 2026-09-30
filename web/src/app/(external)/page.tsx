import { redirect } from "next/navigation";

export default function Home() {
  redirect("/dashboard/monitor");
  return <>Coming Soon</>;
}

import { Gate } from "@/components/gate";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Gate>{children}</Gate>;
}

import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import { Wordmark } from "@/components/brand";

export default function Page() {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-page px-4 pt-10 pb-16">
      <Link href="/" className="mb-8">
        <Wordmark className="text-[24px]" />
      </Link>
      <SignUp />
    </div>
  );
}

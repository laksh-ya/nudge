export function Initials({ name }: { name: string }) {
  const chinese = /[一-鿿]/.test(name);
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-page text-label font-bold text-navy">
      {chinese ? name.slice(0, 1) : name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "•"}
    </span>
  );
}

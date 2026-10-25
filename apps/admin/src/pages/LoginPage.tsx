import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { navigate } from "../lib/router.js";
import { useSession } from "../session.js";
import { Button, Field } from "../components/ui.js";

const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-[var(--tpirs-color-primary)] focus:outline-none";

const loginSchema = z.object({
  tenantSlug: z.string().min(1, "Tenant slug is required"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  totpCode: z.string().optional(),
});

type LoginForm = z.infer<typeof loginSchema>;

/** Step 1: staff sign-in. Sends credentials once; code + password never cached. */
export function LoginPage(): ReactElement {
  const login = useSession((state) => (input: Parameters<typeof state.login>[0]) => state.login(input));
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });

  const onSubmit = (values: LoginForm): void => {
    void (async () => {
      setSubmitting(true);
      try {
        await login({
          tenantSlug: values.tenantSlug,
          username: values.username,
          password: values.password,
          ...(values.totpCode === undefined || values.totpCode === "" ? {} : { totpCode: values.totpCode }),
        });
        navigate("/registry");
      } catch {
        // Toast host surfaces the error envelope (message + request id).
      } finally {
        setSubmitting(false);
      }
    })();
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4">
      <h1 className="mb-6 text-xl font-semibold text-slate-900">Staff sign-in</h1>
      <form
        className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        onSubmit={(event) => {
          void handleSubmit(onSubmit)(event);
        }}
      >
        <Field label="Tenant slug" {...(errors.tenantSlug?.message === undefined ? {} : { error: errors.tenantSlug.message })}>
          <input className={inputClass} {...register("tenantSlug")} autoComplete="off" placeholder="example-state" />
        </Field>
        <Field label="Username" {...(errors.username?.message === undefined ? {} : { error: errors.username.message })}>
          <input className={inputClass} {...register("username")} autoComplete="username" />
        </Field>
        <Field label="Password" {...(errors.password?.message === undefined ? {} : { error: errors.password.message })}>
          <input className={inputClass} {...register("password")} type="password" autoComplete="current-password" />
        </Field>
        <Field label="Two-factor code" hint="Optional when your account has no authenticator." {...(errors.totpCode?.message === undefined ? {} : { error: errors.totpCode.message })}>
          <input className={inputClass} {...register("totpCode")} inputMode="numeric" autoComplete="one-time-code" />
        </Field>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}

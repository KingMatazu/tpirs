import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { api } from "../api/client.js";
import { unwrap } from "../api/unwrap.js";
import { Button, Card, Field, ReadOnlyNote, TextInput } from "./ui.js";
import {
  ownerCreateBody,
  ownerPhoneParam,
  ownerVerifiedLabel,
  ownerVerifyConfirmBody,
  ownerVerifyRequestBody,
  reassignOwnerBody,
  type OwnerView,
} from "../lib/registryView.js";
import { describeError, pushToast } from "../toast.js";
import { useSession } from "../session.js";

/**
 * The person liable for one vehicle: who they are, whether their phone is
 * verified, and — for a supervisor — how to hand the vehicle to someone else.
 *
 * A motorbike changes hands; the sticker, the short code and the payment history
 * stay with the vehicle, and only the liable person changes. That is a
 * supervisory act, so the reassignment block is shown to `asset:create` holders
 * only — the same permission that registers a driver in the first place.
 */
export function OwnerPanel(props: {
  readonly assetId: string;
  readonly initialOwnerId: string | null;
  readonly initialOwnerName: string | null;
  readonly onChanged: () => Promise<void>;
}): ReactElement {
  const canReassign = useSession((state) => state.hasPermission("asset:create"));
  const [owner, setOwner] = useState<OwnerView | undefined>(undefined);
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState<OwnerView | undefined>(undefined);
  const [displayName, setDisplayName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * The asset already names its owner, so the panel opens on that person: the
   * lookup form used to make an operator paste an id before seeing a name they
   * had already been shown in the table.
   */
  useEffect(() => {
    const id = props.initialOwnerId;
    if (id === null) return;
    void (async () => {
      try {
        const response = await unwrap(api.GET("/v1/owners/{id}", { params: { path: { id } } }));
        setOwner(response.owner);
      } catch {
        // The name from the asset list still renders; the lookup is a detail.
      }
    })();
  }, [props.initialOwnerId]);

  const requestCode = async (): Promise<void> => {
    if (owner === undefined) return;
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/owners/verify/request", {
          body: ownerVerifyRequestBody({ ownerId: owner.id }),
        }),
      );
      pushToast({ kind: "success", message: "Verification code sent." });
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (owner === undefined) return;
    if (code.trim() === "") {
      pushToast({ kind: "error", message: "The code from the SMS is required." });
      return;
    }
    setBusy(true);
    try {
      const verified = await unwrap(
        api.POST("/v1/owners/verify/confirm", {
          body: ownerVerifyConfirmBody(owner.id, code),
        }),
      );
      setOwner(verified.owner);
      setCode("");
      pushToast({ kind: "success", message: "Owner phone verified." });
      await props.onChanged();
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  /** Hands the vehicle over and leaves the panel showing the new owner. */
  const reassign = async (next: OwnerView): Promise<void> => {
    setBusy(true);
    try {
      await unwrap(
        api.PUT("/v1/assets/{id}/owner", {
          params: { path: { id: props.assetId } },
          body: reassignOwnerBody(next.id),
        }),
      );
      setOwner(next);
      setFound(undefined);
      setPhone("");
      setDisplayName("");
      setNewPhone("");
      setNewEmail("");
      pushToast({ kind: "success", message: `Vehicle handed to ${next.displayName}.` });
      await props.onChanged();
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const findOwner = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (phone.trim() === "") {
      pushToast({ kind: "error", message: "Enter the person's phone number." });
      return;
    }
    setBusy(true);
    try {
      const response = await unwrap(
        api.GET("/v1/owners/by-phone/{phone}", {
          params: { path: { phone: ownerPhoneParam(phone) } },
        }),
      );
      setFound(response.owner);
    } catch (error) {
      setFound(undefined);
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const createAndReassign = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (displayName.trim() === "" || newPhone.trim() === "") {
      pushToast({ kind: "error", message: "A name and phone number are required." });
      return;
    }
    setBusy(true);
    try {
      const created = await unwrap(
        api.POST("/v1/owners", { body: ownerCreateBody(displayName, newPhone, newEmail) }),
      );
      await reassign(created.owner);
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const name = owner?.displayName ?? props.initialOwnerName;

  return (
    <Card title="Owner" description="The person liable for this vehicle.">
      {name === null ? (
        <ReadOnlyNote>
          No owner is linked to this asset. Owners are attached when a driver is registered.
        </ReadOnlyNote>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Name</dt>
          <dd className="text-slate-900">{name}</dd>
          {owner === undefined ? null : (
            <>
              <dt className="text-slate-500">Phone</dt>
              <dd className="text-slate-900">{owner.phone}</dd>
              <dt className="text-slate-500">Verification</dt>
              <dd className="text-slate-900">{ownerVerifiedLabel(owner)}</dd>
            </>
          )}
        </dl>
      )}

      {owner === undefined ? null : (
        <div className="mt-4 space-y-3">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              void requestCode();
            }}
          >
            Send verification code
          </Button>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => void confirm(event)}
          >
            <Field label="Verification code">
              <TextInput name="code" inputMode="numeric" value={code} onValueChange={setCode} />
            </Field>
            <Button type="submit" disabled={busy}>
              Confirm code
            </Button>
          </form>
        </div>
      )}

      {canReassign ? (
        <div className="mt-6 space-y-4 border-t border-slate-100 pt-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">
              Hand this vehicle to someone else
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              For a sale or a transfer. The sticker, the short code and the payment history stay
              with the vehicle; only the person liable changes, and the audit trail records the
              previous owner.
            </p>
          </div>

          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => void findOwner(event)}
          >
            <Field label="Their phone number" hint="If they already have a vehicle registered.">
              <TextInput
                name="reassignPhone"
                inputMode="tel"
                value={phone}
                onValueChange={setPhone}
                placeholder="+234…"
              />
            </Field>
            <Button type="submit" variant="ghost" disabled={busy}>
              Find
            </Button>
          </form>

          {found === undefined ? null : (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="text-sm text-slate-900">
                {found.displayName} — {found.phone}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Phone {ownerVerifiedLabel(found).toLowerCase()}.
              </p>
              <div className="mt-2">
                <Button
                  disabled={busy}
                  onClick={() => {
                    void reassign(found);
                  }}
                >
                  Hand over to {found.displayName}
                </Button>
              </div>
            </div>
          )}

          <details>
            <summary className="cursor-pointer text-sm text-slate-600">
              The new owner is not registered yet
            </summary>
            <form
              className="mt-3 flex flex-wrap items-end gap-3"
              onSubmit={(event) => void createAndReassign(event)}
            >
              <Field label="The new owner's name">
                <TextInput name="newOwnerName" value={displayName} onValueChange={setDisplayName} />
              </Field>
              <Field label="The new owner's phone">
                <TextInput
                  name="newOwnerPhone"
                  inputMode="tel"
                  value={newPhone}
                  onValueChange={setNewPhone}
                  placeholder="+234…"
                />
              </Field>
              <Field label="The new owner's email (optional)">
                <TextInput
                  name="newOwnerEmail"
                  type="email"
                  value={newEmail}
                  onValueChange={setNewEmail}
                />
              </Field>
              <Button type="submit" disabled={busy}>
                Create and hand over
              </Button>
            </form>
          </details>
        </div>
      ) : null}
    </Card>
  );
}

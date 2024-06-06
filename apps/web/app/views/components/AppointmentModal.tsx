import { useParams } from "@/framework/ClientRouterContext";
import {
  FormError,
  Mutation,
  useMutationStatus,
  ValidationErrors,
} from "@/framework/client/Mutation";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Spacer,
  DatePicker,
  CheckboxGroup,
  Checkbox,
} from "@nextui-org/react";
import { useState } from "react";

const SubmitButton = () => {
  const { isPending } = useMutationStatus();
  return (
    <Button isLoading={isPending} color="primary" type="submit">
      Submit
    </Button>
  );
};

export const AppointmentModal = ({
  isOpen,
  onOpen,
  onOpenChange,
  host,
  productId,
}) => {
  const { organizationId } = useParams();
  const [success, setSuccess] = useState(false);

  if (success) {
    return (
      <Modal size="3xl" isOpen={isOpen} onOpenChange={onOpenChange}>
        <ModalContent>
          <ModalHeader>Appointment set successfully</ModalHeader>
          <ModalBody>
            <p>
              Your appointment has been set successfully. You will receive an
              email with the details.
            </p>
          </ModalBody>
          <ModalFooter>
            <Button
              color="primary"
              variant="light"
              onPress={() => {
                onOpenChange(false);
                setSuccess(false);
              }}
            >
              Close
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    );
  }

  return (
    <>
      <Modal size="3xl" isOpen={isOpen} onOpenChange={onOpenChange}>
        <ModalContent>
          {(onClose) => (
            <>
              <Mutation
                url={`/organisation/${organizationId}/appointment/${host.id}`}
                onSuccess={() => {
                  setSuccess(true);
                }}
              >
                <input type="hidden" name="productId" value={productId} />
                <ModalHeader className="flex flex-col gap-1">
                  Set an appointment
                </ModalHeader>
                <ModalBody>
                  <div>
                    <div className="flex gap-4">
                      <div className="flex flex-col grow">
                        <Input
                          validate={() => true}
                          name="firstName"
                          label="First Name"
                          isRequired
                        />
                        <ValidationErrors name="firstName" />
                      </div>
                      <div className="flex flex-col grow">
                        <Input name="lastName" label="Last Name" isRequired />
                        <ValidationErrors name="lastName" />
                      </div>
                    </div>
                    <Spacer y={3} />
                    <div className="flex gap-4">
                      <div className="flex flex-col grow">
                        <Input name="phone" label="Phone number" isRequired />
                        <ValidationErrors name="phone" />
                      </div>
                      <div className="flex flex-col grow">
                        <Input
                          name="email"
                          type="email"
                          label="Email"
                          isRequired
                        />
                        <ValidationErrors name="email" />
                      </div>
                    </div>
                    <Spacer y={3} />
                    <div className="flex gap-4">
                      <div className="flex flex-col grow">
                        <DatePicker name="date" label="Date" isRequired />
                        <ValidationErrors name="date" />
                      </div>
                      <div className="flex flex-col grow">
                        <DatePicker
                          name="alternativeDate"
                          label="Alternative date"
                          isRequired
                        />
                        <ValidationErrors name="alternativeDate1" />
                      </div>
                    </div>

                    <Spacer y={3} />
                    <div className="flex gap-4">
                      <div className="flex basis-1/2 flex-col px-2">
                        <CheckboxGroup
                          className=""
                          label="Select preferred timing window"
                          name="preferredTimeWindow"
                          isRequired
                          defaultValue={["morning", "afternoon"]}
                        >
                          <Checkbox value="morning">Morning</Checkbox>
                          <Checkbox value="afternoon">Afternoon</Checkbox>
                          <Checkbox value="evening">Evening</Checkbox>
                        </CheckboxGroup>
                        <ValidationErrors name="preferredTimeWindow" />
                      </div>
                      <div className="flex flex-col basis-1/2">
                        <Input name="zipCode" label="Zip code" isRequired />
                        <ValidationErrors name="zipCode" />
                      </div>
                    </div>
                    <FormError className="text-red-400 text-sm px-3 pt-4" />
                  </div>
                </ModalBody>
                <ModalFooter>
                  <Button color="danger" variant="light" onPress={onClose}>
                    Cancel
                  </Button>
                  <SubmitButton />
                </ModalFooter>
              </Mutation>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
};

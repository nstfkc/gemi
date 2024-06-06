import {
  Button,
  Card,
  CardBody,
  Spacer,
  useDisclosure,
} from "@nextui-org/react";
import type { Host, HostAddress, HostProducts, Product } from "@prisma/client";
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map,
  useAdvancedMarkerRef,
} from "@vis.gl/react-google-maps";
import { useCallback, useState } from "react";
import { AppointmentModal } from "./components/AppointmentModal";

const center = {
  lat: 51.1657,
  lng: 10.4515,
};

const MarkerWithInfoWindow = ({
  host,
}: {
  host: Host & {
    address: HostAddress;
    HostProducts: (HostProducts & { Product: Product })[];
  };
}) => {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  // `markerRef` and `marker` are needed to establish the connection between
  // the marker and infowindow (if you're using the Marker component, you
  // can use the `useMarkerRef` hook instead).
  const [markerRef, marker] = useAdvancedMarkerRef();

  const [infoWindowShown, setInfoWindowShown] = useState(false);

  // clicking the marker will toggle the infowindow
  const handleMarkerClick = useCallback(
    () => setInfoWindowShown((isShown) => !isShown),
    [],
  );

  // if the maps api closes the infowindow, we have to synchronize our state
  const handleClose = useCallback(() => setInfoWindowShown(false), []);

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: host.address.lat, lng: host.address.lng }}
        onClick={handleMarkerClick}
      />

      {infoWindowShown && (
        <InfoWindow anchor={marker} onClose={handleClose}>
          <div className="p-2">
            <h2 className="text-lg font-semibold">
              {host.address.zip} - {host.address.city}
            </h2>
            <div>
              {host.HostProducts.map(({ Product }) => (
                <div className="text-lg" key={Product.id}>
                  {Product.name}
                </div>
              ))}
            </div>
            <Spacer y={3} />
            <Button onClick={onOpen} color="primary">
              Set an appointment
            </Button>
          </div>
        </InfoWindow>
      )}
      <AppointmentModal
        productId={host.HostProducts[0].productId}
        host={host}
        isOpen={isOpen}
        onOpen={onOpen}
        onOpenChange={onOpenChange}
      />
    </>
  );
};

export default function MapView(props) {
  const { hosts } = props;

  return (
    <APIProvider
      apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}
      libraries={["marker"]}
    >
      <Map
        mapId="map"
        style={{ width: "100vw", height: "100dvh" }}
        defaultCenter={center}
        defaultZoom={6}
        disableDefaultUI
      >
        {hosts.map((host) => (
          <MarkerWithInfoWindow key={host.id} host={host} />
        ))}
      </Map>
    </APIProvider>
  );
}

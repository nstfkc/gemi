import { Swiper, SwiperSlide } from "swiper/react";
import { Navigation } from "swiper/modules";

import "swiper/css";
import "swiper/css/navigation";

export const Carousel = () => {
  return (
    <Swiper navigation={true} modules={[Navigation]} className="mySwiper">
      <SwiperSlide>slide 1</SwiperSlide>
      <SwiperSlide>slide 1</SwiperSlide>
    </Swiper>
  );
};

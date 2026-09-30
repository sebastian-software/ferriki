! Fortran free form: derived types, arrays, filtering and formatted output.
module billing
  use iso_fortran_env, only: int64
  implicit none
  private
  public :: order, total_for
  type :: order
    character(len=24) :: customer
    integer(int64) :: cents
    logical :: completed = .true.
  end type order
contains
  pure function total_for(values, customer) result(total)
    type(order), intent(in) :: values(:)
    character(len=*), intent(in) :: customer
    integer(int64) :: total
    integer :: i
    total = 0_int64
    do i = 1, size(values)
      if (values(i)%completed .and. trim(values(i)%customer) == customer) then
        total = total + values(i)%cents
      end if
    end do
  end function total_for
end module billing

program orders
  use billing
  use iso_fortran_env, only: int64
  implicit none
  type(order) :: values(3)
  values = [order("Ada", 1995_int64, .true.), &
            order("Zoe", 1250_int64, .true.), order("Ada", 500_int64, .false.)]
  print '(A,I0,A)', '<total> ', total_for(values, "Ada"), ' cents </total>'
end program orders
